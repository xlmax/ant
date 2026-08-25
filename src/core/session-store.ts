import { appendFile, mkdir, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentEvent, AgentObserver, AgentState, HistoryEvent } from "./agent.js";
import { writeFileAtomically } from "../fs/atomic-write.js";

const SESSION_VERSION = 1;
const SESSION_METADATA_VERSION = 2;

interface SessionRecord {
  version: typeof SESSION_VERSION;
  sessionId: string;
  timestamp: string;
  event: AgentEvent;
}

export interface AgentSession {
  id: string;
  filePath: string;
  observer: AgentObserver;
}

export interface SessionSummary {
  id: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  task: string;
}

export interface SessionList {
  sessions: SessionSummary[];
  warnings: string[];
}

function assertSessionId(sessionId: string): void {
  if (!/^[a-f0-9-]+$/iu.test(sessionId)) {
    throw new Error("Недопустимый идентификатор сессии");
  }
}

function sessionFilePath(sessionDirectory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(sessionDirectory, `${sessionId}.jsonl`);
}

function sessionMetadataPath(sessionDirectory: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(sessionDirectory, `${sessionId}.meta.json`);
}

function parseRecord(line: string, lineNumber: number): SessionRecord {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Сессия содержит некорректный JSON в строке ${lineNumber}`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    !("sessionId" in value) ||
    !("timestamp" in value) ||
    !("event" in value) ||
    value.version !== SESSION_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    throw new Error(`Сессия содержит некорректную запись в строке ${lineNumber}`);
  }

  return value as SessionRecord;
}

function serializeRecord(sessionId: string, event: AgentEvent, timestamp: string): string {
  const record: SessionRecord = {
    version: SESSION_VERSION,
    sessionId,
    timestamp,
    event,
  };

  return `${JSON.stringify(record)}\n`;
}

/**
 * Only history events are written to the journal. The allow-list makes a
 * future lifecycle event fail safe: a type not listed here is simply not
 * persisted, instead of silently leaking into the session file.
 */
export function isPersistedEvent(event: AgentEvent): event is HistoryEvent {
  return (
    event.type === "task" ||
    event.type === "user" ||
    event.type === "decision" ||
    event.type === "compaction" ||
    event.type === "observation"
  );
}

function summaryFromRecords(
  id: string,
  filePath: string,
  records: readonly SessionRecord[],
): SessionSummary {
  if (records.some((record) => record.sessionId !== id)) {
    throw new Error("Идентификатор сессии не совпадает с содержимым файла");
  }

  const first = records[0]!;
  const last = records.at(-1)!;
  const task = records.find((record) => record.event.type === "task")?.event;
  return {
    id,
    filePath,
    createdAt: first.timestamp,
    updatedAt: last.timestamp,
    task: task?.type === "task" ? task.content : "Без исходной задачи",
  };
}

async function writeSessionMetadata(
  sessionDirectory: string,
  summary: SessionSummary,
): Promise<void> {
  try {
    const fileStat = await stat(summary.filePath);
    await writeFileAtomically(
      sessionMetadataPath(sessionDirectory, summary.id),
      `${JSON.stringify(
        {
          version: SESSION_METADATA_VERSION,
          id: summary.id,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          task: summary.task,
          fileSize: fileStat.size,
          modifiedAtMs: fileStat.mtimeMs,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // The sidecar is a best-effort cache; the JSONL journal remains the
    // source of truth. A transient failure here (for example EPERM on
    // Windows) must not fail the agent turn or the session lifecycle.
  }
}

async function readSessionMetadata(
  sessionDirectory: string,
  id: string,
): Promise<SessionSummary | undefined> {
  const filePath = sessionMetadataPath(sessionDirectory, id);
  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Метаданные сессии содержат некорректный JSON");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    !("id" in value) ||
    !("createdAt" in value) ||
    !("updatedAt" in value) ||
    !("task" in value) ||
    !("fileSize" in value) ||
    !("modifiedAtMs" in value) ||
    value.version !== SESSION_METADATA_VERSION ||
    value.id !== id ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.task !== "string" ||
    typeof value.fileSize !== "number" ||
    typeof value.modifiedAtMs !== "number"
  ) {
    throw new Error("Метаданные сессии имеют некорректный формат");
  }

  const sessionPath = sessionFilePath(sessionDirectory, id);
  const sessionStat = await stat(sessionPath);
  if (sessionStat.size !== value.fileSize || sessionStat.mtimeMs !== value.modifiedAtMs) {
    return undefined;
  }

  return {
    id,
    filePath: sessionPath,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    task: value.task,
  };
}

interface ReadSessionRecordsResult {
  records: SessionRecord[];
  /** Byte length of the clean journal boundary (excludes a torn tail). */
  validBytes: number;
  /** True when the final record is valid but the file lacks a trailing newline. */
  needsNewlineSeparator: boolean;
}

async function readSessionRecords(filePath: string): Promise<ReadSessionRecordsResult> {
  const content = await readFile(filePath, "utf8");
  const records: SessionRecord[] = [];
  const lines = content.split(/\r?\n/u);
  const hasIncompleteTail = content !== "" && !content.endsWith("\n");
  let tornTail = false;
  for (const [index, line] of lines.entries()) {
    if (line) {
      try {
        records.push(parseRecord(line, index + 1));
      } catch (error) {
        if (hasIncompleteTail && index === lines.length - 1 && records.length > 0) {
          tornTail = true;
          break;
        }
        throw error;
      }
    }
  }

  if (records.length === 0) {
    throw new Error("Невозможно продолжить пустую сессию");
  }

  // File ends with a newline: every line on disk is a well-formed record.
  if (!hasIncompleteTail) {
    return {
      records,
      validBytes: Buffer.byteLength(content, "utf8"),
      needsNewlineSeparator: false,
    };
  }

  // No trailing newline. A valid final record must be kept, not truncated:
  // only a genuinely torn tail gets trimmed back to the previous boundary.
  if (!tornTail) {
    return {
      records,
      validBytes: Buffer.byteLength(content, "utf8"),
      needsNewlineSeparator: true,
    };
  }

  const lastNewline = content.lastIndexOf("\n");
  return {
    records,
    validBytes: lastNewline < 0 ? 0 : Buffer.byteLength(content.slice(0, lastNewline + 1), "utf8"),
    needsNewlineSeparator: false,
  };
}

class JsonlSessionObserver implements AgentObserver {
  readonly #sessionDirectory: string;
  readonly #sessionId: string;
  readonly #filePath: string;
  #summary: SessionSummary;

  constructor(sessionDirectory: string, summary: SessionSummary) {
    this.#sessionDirectory = sessionDirectory;
    this.#sessionId = summary.id;
    this.#filePath = summary.filePath;
    this.#summary = summary;
  }

  async onEvent(event: AgentEvent): Promise<void> {
    if (!isPersistedEvent(event)) {
      return;
    }

    const timestamp = new Date().toISOString();
    await appendFile(this.#filePath, serializeRecord(this.#sessionId, event, timestamp), "utf8");
    this.#summary = {
      ...this.#summary,
      updatedAt: timestamp,
      ...(event.type === "task" ? { task: event.content } : {}),
    };
    await writeSessionMetadata(this.#sessionDirectory, this.#summary);
  }
}

export class JsonlSessionStore {
  readonly #sessionDirectory: string;

  constructor(sessionDirectory: string) {
    this.#sessionDirectory = sessionDirectory;
  }

  async create(state: AgentState): Promise<AgentSession> {
    const id = randomUUID();
    const filePath = sessionFilePath(this.#sessionDirectory, id);
    const createdAt = new Date().toISOString();
    const task = state.events.find((event) => event.type === "task");
    const summary: SessionSummary = {
      id,
      filePath,
      createdAt,
      updatedAt: createdAt,
      task: task?.type === "task" ? task.content : "Без исходной задачи",
    };

    await mkdir(this.#sessionDirectory, { recursive: true });
    await writeFileAtomically(
      filePath,
      state.events
        .filter((event) => isPersistedEvent(event))
        .map((event) => serializeRecord(id, event, createdAt))
        .join(""),
    );
    await writeSessionMetadata(this.#sessionDirectory, summary);

    return {
      id,
      filePath,
      observer: new JsonlSessionObserver(this.#sessionDirectory, summary),
    };
  }

  async list(): Promise<SessionList> {
    let entries: Array<{ name: string; isFile(): boolean }>;

    try {
      entries = await readdir(this.#sessionDirectory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [], warnings: [] };
      }
      throw error;
    }

    const sessions: SessionSummary[] = [];
    const warnings: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const id = entry.name.slice(0, -".jsonl".length);
      if (!/^[a-f0-9-]+$/iu.test(id)) {
        continue;
      }

      const filePath = sessionFilePath(this.#sessionDirectory, id);

      try {
        let summary: SessionSummary | undefined;
        try {
          summary = await readSessionMetadata(this.#sessionDirectory, id);
        } catch {
          summary = undefined;
        }

        if (!summary) {
          summary = summaryFromRecords(id, filePath, (await readSessionRecords(filePath)).records);
          await writeSessionMetadata(this.#sessionDirectory, summary);
        }

        sessions.push(summary);
      } catch (error) {
        warnings.push(
          `Сессия ${id} пропущена: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      sessions: sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      warnings,
    };
  }

  async resume(sessionId: string): Promise<{
    state: AgentState;
    session: AgentSession;
  }> {
    const filePath = sessionFilePath(this.#sessionDirectory, sessionId);
    const { records, validBytes, needsNewlineSeparator } = await readSessionRecords(filePath);

    if (needsNewlineSeparator) {
      // A valid final record without a trailing newline: keep it untouched and
      // only add the separator so the next appendFile lands on a new line.
      await appendFile(filePath, "\n", "utf8");
    } else if (validBytes < (await stat(filePath)).size) {
      // A crashed session may end with a torn tail line that the parser
      // ignored. Trim it so the next appendFile lands on a clean record
      // boundary instead of concatenating new JSON onto the damaged tail.
      await truncate(filePath, validBytes);
    }

    const summary = summaryFromRecords(sessionId, filePath, records);
    await writeSessionMetadata(this.#sessionDirectory, summary);

    return {
      state: { events: records.map((record) => record.event).filter(isPersistedEvent) },
      session: {
        id: sessionId,
        filePath,
        observer: new JsonlSessionObserver(this.#sessionDirectory, summary),
      },
    };
  }
}

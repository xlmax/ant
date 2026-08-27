import { appendFile, mkdir, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  CreateSessionInput,
  ReadSession,
  SessionList,
  SessionRecord,
  SessionStore,
  SessionSummary,
} from "../app/session.js";
import { writeFileAtomically } from "../fs/atomic-write.js";

const SESSION_VERSION = 2;
const SESSION_METADATA_VERSION = 2;

interface StoredSessionRecord extends SessionRecord {
  sessionId: string;
  timestamp: string;
  payload: unknown;
  task?: string;
}

export interface JsonlAgentSession extends AgentSession {
  filePath: string;
  location: string;
}

interface JsonlSessionSummary extends SessionSummary {
  filePath: string;
}

class InvalidRecordJsonError extends Error {}

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

function parseRecord(line: string, lineNumber: number): StoredSessionRecord {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    throw new InvalidRecordJsonError(`Сессия содержит некорректный JSON в строке ${lineNumber}`);
  }

  if (typeof value !== "object" || value === null) {
    throw new Error(`Сессия содержит некорректную запись в строке ${lineNumber}`);
  }
  if (
    "version" in value &&
    value.version === 1 &&
    "sessionId" in value &&
    "timestamp" in value &&
    "event" in value &&
    typeof value.sessionId === "string" &&
    typeof value.timestamp === "string"
  ) {
    const event = value.event;
    const task =
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task" &&
      "content" in event &&
      typeof event.content === "string"
        ? event.content
        : undefined;
    return {
      schemaVersion: SESSION_VERSION,
      sessionId: value.sessionId,
      timestamp: value.timestamp,
      payload: { schemaVersion: 1, kind: "history-event", event },
      ...(task === undefined ? {} : { task }),
    };
  }
  if (
    "schemaVersion" in value &&
    typeof value.schemaVersion === "number" &&
    value.schemaVersion !== SESSION_VERSION
  ) {
    throw new Error(
      `Неподдерживаемая версия session envelope ${value.schemaVersion} в строке ${lineNumber}`,
    );
  }
  if (
    !("schemaVersion" in value) ||
    !("sessionId" in value) ||
    !("timestamp" in value) ||
    !("payload" in value) ||
    value.schemaVersion !== SESSION_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.timestamp !== "string" ||
    ("task" in value && typeof value.task !== "string")
  ) {
    throw new Error(`Сессия содержит некорректную запись в строке ${lineNumber}`);
  }
  return value as StoredSessionRecord;
}

function serializeRecord(
  sessionId: string,
  payload: unknown,
  timestamp: string,
  task?: string,
): string {
  const record: StoredSessionRecord = {
    schemaVersion: SESSION_VERSION,
    sessionId,
    timestamp,
    payload: structuredClone(payload),
    ...(task === undefined ? {} : { task }),
  };

  return `${JSON.stringify(record)}\n`;
}

function summaryFromRecords(
  id: string,
  filePath: string,
  records: readonly StoredSessionRecord[],
): JsonlSessionSummary {
  if (records.some((record) => record.sessionId !== id)) {
    throw new Error("Идентификатор сессии не совпадает с содержимым файла");
  }

  const first = records[0]!;
  const last = records.at(-1)!;
  const task = records.find((record) => record.task !== undefined)?.task;
  return {
    id,
    filePath,
    createdAt: first.timestamp,
    updatedAt: last.timestamp,
    task: task ?? "Без исходной задачи",
  };
}

async function writeSessionMetadata(
  sessionDirectory: string,
  summary: JsonlSessionSummary,
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
): Promise<JsonlSessionSummary | undefined> {
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
  records: StoredSessionRecord[];
  /** Byte length of the clean journal boundary (excludes a torn tail). */
  validBytes: number;
  /** True when the final record is valid but the file lacks a trailing newline. */
  needsNewlineSeparator: boolean;
}

async function readSessionRecords(filePath: string): Promise<ReadSessionRecordsResult> {
  const content = await readFile(filePath, "utf8");
  const records: StoredSessionRecord[] = [];
  const lines = content.split(/\r?\n/u);
  const hasIncompleteTail = content !== "" && !content.endsWith("\n");
  let tornTail = false;
  for (const [index, line] of lines.entries()) {
    if (line) {
      try {
        records.push(parseRecord(line, index + 1));
      } catch (error) {
        if (
          error instanceof InvalidRecordJsonError &&
          hasIncompleteTail &&
          index === lines.length - 1 &&
          records.length > 0
        ) {
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

export class JsonlSessionStore implements SessionStore {
  readonly #sessionDirectory: string;

  constructor(sessionDirectory: string) {
    this.#sessionDirectory = sessionDirectory;
  }

  async create(input: CreateSessionInput): Promise<JsonlAgentSession> {
    const id = randomUUID();
    const filePath = sessionFilePath(this.#sessionDirectory, id);
    const createdAt = new Date().toISOString();
    const summary: JsonlSessionSummary = {
      id,
      filePath,
      createdAt,
      updatedAt: createdAt,
      task: input.task,
    };

    await mkdir(this.#sessionDirectory, { recursive: true });
    await writeFileAtomically(
      filePath,
      input.payloads
        .map((payload, index) =>
          serializeRecord(id, payload, createdAt, index === 0 ? input.task : undefined),
        )
        .join(""),
    );
    await writeSessionMetadata(this.#sessionDirectory, summary);

    return {
      id,
      filePath,
      location: filePath,
    };
  }

  async append(sessionId: string, payload: unknown): Promise<SessionRecord> {
    const filePath = sessionFilePath(this.#sessionDirectory, sessionId);
    await stat(filePath);
    const timestamp = new Date().toISOString();
    await appendFile(filePath, serializeRecord(sessionId, payload, timestamp), "utf8");
    const records = (await readSessionRecords(filePath)).records;
    await writeSessionMetadata(
      this.#sessionDirectory,
      summaryFromRecords(sessionId, filePath, records),
    );
    return {
      schemaVersion: SESSION_VERSION,
      sessionId,
      timestamp,
      payload: structuredClone(payload),
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

    const sessions: JsonlSessionSummary[] = [];
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
        let summary: JsonlSessionSummary | undefined;
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
      sessions: sessions
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(({ id, createdAt, updatedAt, task }) => ({ id, createdAt, updatedAt, task })),
      warnings,
    };
  }

  async read(sessionId: string): Promise<ReadSession> {
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
    const session: JsonlAgentSession = { id: sessionId, filePath, location: filePath };

    return {
      records: records.map(({ schemaVersion, sessionId: id, timestamp, payload }) => ({
        schemaVersion,
        sessionId: id,
        timestamp,
        payload: structuredClone(payload),
      })),
      session,
    };
  }
}

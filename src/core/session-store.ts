import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentEvent, AgentObserver, AgentState } from "./agent.js";

const SESSION_VERSION = 1;

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

function sessionFilePath(sessionDirectory: string, sessionId: string): string {
  if (!/^[a-f0-9-]+$/iu.test(sessionId)) {
    throw new Error("Недопустимый идентификатор сессии");
  }

  return join(sessionDirectory, `${sessionId}.jsonl`);
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

function serializeRecord(sessionId: string, event: AgentEvent): string {
  const record: SessionRecord = {
    version: SESSION_VERSION,
    sessionId,
    timestamp: new Date().toISOString(),
    event,
  };

  return `${JSON.stringify(record)}\n`;
}

async function readSessionRecords(filePath: string): Promise<SessionRecord[]> {
  const content = await readFile(filePath, "utf8");
  const records = content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => parseRecord(line, index + 1));

  if (records.length === 0) {
    throw new Error("Невозможно продолжить пустую сессию");
  }

  return records;
}

class JsonlSessionObserver implements AgentObserver {
  readonly #sessionId: string;
  readonly #filePath: string;

  constructor(sessionId: string, filePath: string) {
    this.#sessionId = sessionId;
    this.#filePath = filePath;
  }

  async onEvent(event: AgentEvent): Promise<void> {
    await appendFile(this.#filePath, serializeRecord(this.#sessionId, event), "utf8");
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

    await mkdir(this.#sessionDirectory, { recursive: true });
    await writeFile(
      filePath,
      state.events.map((event) => serializeRecord(id, event)).join(""),
      "utf8",
    );

    return {
      id,
      filePath,
      observer: new JsonlSessionObserver(id, filePath),
    };
  }

  async list(): Promise<SessionSummary[]> {
    let entries: Array<{ name: string; isFile(): boolean }>;

    try {
      entries = await readdir(this.#sessionDirectory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const id = entry.name.slice(0, -".jsonl".length);
      if (!/^[a-f0-9-]+$/iu.test(id)) {
        continue;
      }

      const filePath = sessionFilePath(this.#sessionDirectory, id);
      const records = await readSessionRecords(filePath);
      const first = records[0]!;
      const last = records.at(-1)!;
      const task = records.find((record) => record.event.type === "task")?.event;

      sessions.push({
        id,
        filePath,
        createdAt: first.timestamp,
        updatedAt: last.timestamp,
        task: task?.type === "task" ? task.content : "Без исходной задачи",
      });
    }

    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async resume(sessionId: string): Promise<{
    state: AgentState;
    session: AgentSession;
  }> {
    const filePath = sessionFilePath(this.#sessionDirectory, sessionId);
    const records = await readSessionRecords(filePath);

    for (const record of records) {
      if (record.sessionId !== sessionId) {
        throw new Error("Идентификатор сессии не совпадает с содержимым файла");
      }
    }

    return {
      state: { events: records.map((record) => record.event) },
      session: {
        id: sessionId,
        filePath,
        observer: new JsonlSessionObserver(sessionId, filePath),
      },
    };
  }
}

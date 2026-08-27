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

interface Entry {
  session: AgentSession;
  records: SessionRecord[];
  summary: SessionSummary;
}

export class MemorySessionStore implements SessionStore {
  readonly #entries = new Map<string, Entry>();

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const session = { id };
    this.#entries.set(id, {
      session,
      records: input.payloads.map((payload) => ({
        schemaVersion: 2,
        sessionId: id,
        timestamp,
        payload: structuredClone(payload),
      })),
      summary: { id, createdAt: timestamp, updatedAt: timestamp, task: input.task },
    });
    return session;
  }

  async append(sessionId: string, payload: unknown): Promise<SessionRecord> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const timestamp = new Date().toISOString();
    const record: SessionRecord = {
      schemaVersion: 2,
      sessionId,
      timestamp,
      payload: structuredClone(payload),
    };
    entry.records.push(record);
    entry.summary = { ...entry.summary, updatedAt: timestamp };
    return structuredClone(record);
  }

  async read(sessionId: string): Promise<ReadSession> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) throw new Error(`Unknown session: ${sessionId}`);
    return { session: { ...entry.session }, records: structuredClone(entry.records) };
  }

  async list(): Promise<SessionList> {
    return {
      sessions: [...this.#entries.values()]
        .map((entry) => ({ ...entry.summary }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      warnings: [],
    };
  }
}

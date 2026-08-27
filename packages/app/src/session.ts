export interface AgentSession {
  readonly id: string;
  /** Optional human-readable storage location for diagnostics and UI. */
  readonly location?: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  task: string;
}

export interface SessionList {
  sessions: SessionSummary[];
  warnings: string[];
}

export interface SessionRecord {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface CreateSessionInput {
  readonly task: string;
  readonly payloads: readonly unknown[];
}

export interface ReadSession {
  readonly session: AgentSession;
  readonly records: readonly SessionRecord[];
}

/** Durable record store. Payload interpretation belongs to an application codec. */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>;
  append(sessionId: string, payload: unknown): Promise<SessionRecord>;
  read(sessionId: string): Promise<ReadSession>;
  list(): Promise<SessionList>;
}

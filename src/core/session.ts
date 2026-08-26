import type { AgentObserver, AgentState } from "./agent.js";

export interface AgentSession {
  id: string;
  observer: AgentObserver;
  /** Optional human-readable storage location for diagnostics and UI. */
  location?: string;
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

export interface ResumedSession {
  state: AgentState;
  session: AgentSession;
}

/** Durable history contract independent of a concrete storage backend. */
export interface SessionStore {
  create(state: AgentState): Promise<AgentSession>;
  list(): Promise<SessionList>;
  resume(sessionId: string): Promise<ResumedSession>;
}

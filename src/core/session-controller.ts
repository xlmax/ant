import { createAgentState, type AgentState, type HistoryEvent } from "./agent.js";
import { JsonlSessionStore, type AgentSession } from "./session-store.js";

export interface ActiveSession {
  state: AgentState;
  session: AgentSession;
}

export interface PreparedUserMessage extends ActiveSession {
  created: boolean;
}

export class SessionController {
  readonly #store: JsonlSessionStore;
  #active: ActiveSession | undefined;

  constructor(store: JsonlSessionStore) {
    this.#store = store;
  }

  get active(): ActiveSession | undefined {
    return this.#active;
  }

  async resume(sessionId: string): Promise<ActiveSession> {
    this.#active = await this.#store.resume(sessionId);
    return this.#active;
  }

  /**
   * Appends a persistent event to the active session. The journal is written
   * before the in-memory state is mutated so a failed write cannot leave
   * memory ahead of the durable log.
   */
  async appendPersistentEvent(event: HistoryEvent): Promise<void> {
    if (!this.#active) {
      throw new Error("Нет активной сессии");
    }
    await this.#active.session.observer.onEvent(event);
    this.#active.state.events.push(event);
  }

  async prepareUserMessage(content: string): Promise<PreparedUserMessage> {
    if (!this.#active) {
      const state = createAgentState(content);
      const session = await this.#store.create(state);
      this.#active = { state, session };
      return { ...this.#active, created: true };
    }

    const event = { type: "user" as const, content };
    await this.appendPersistentEvent(event);
    return { ...this.#active, created: false };
  }

  reset(): void {
    this.#active = undefined;
  }
}

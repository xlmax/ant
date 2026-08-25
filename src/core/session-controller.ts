import { createAgentState, type AgentState } from "./agent.js";
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

  async prepareUserMessage(content: string): Promise<PreparedUserMessage> {
    if (!this.#active) {
      const state = createAgentState(content);
      const session = await this.#store.create(state);
      this.#active = { state, session };
      return { ...this.#active, created: true };
    }

    const event = { type: "user" as const, content };
    this.#active.state.events.push(event);
    await this.#active.session.observer.onEvent(event);
    return { ...this.#active, created: false };
  }

  reset(): void {
    this.#active = undefined;
  }
}

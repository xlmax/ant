import {
  createAgentState,
  type AgentObserver,
  type AgentState,
  type HistoryEvent,
} from "@ant/core";
import { decodeHistoryEvent, encodeHistoryEvent } from "./session-codec.js";
import type { AgentSession, SessionStore } from "./session.js";

export interface ActiveSession {
  state: AgentState;
  session: AgentSession;
  historyObserver: AgentObserver;
}

export interface PreparedUserMessage extends ActiveSession {
  created: boolean;
}

export class SessionController {
  readonly #store: SessionStore;
  #active: ActiveSession | undefined;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  get active(): ActiveSession | undefined {
    return this.#active;
  }

  async resume(sessionId: string): Promise<ActiveSession> {
    const read = await this.#store.read(sessionId);
    const state = { events: read.records.map((record) => decodeHistoryEvent(record.payload)) };
    this.#active = {
      state,
      session: read.session,
      historyObserver: this.#observer(read.session.id),
    };
    return this.#active;
  }

  getLastTurnEvents(): readonly HistoryEvent[] | undefined {
    const events = this.#active?.state.events;
    if (events === undefined || events.length === 0) return undefined;

    let end = events.length;
    while (end > 0 && events[end - 1]?.type === "compaction") {
      end -= 1;
    }
    if (end === 0) return undefined;

    let start = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "task" || event?.type === "user") {
        start = index;
        break;
      }
    }
    if (start === -1) return undefined;

    return events.slice(start, end);
  }

  /** Persists before mutating memory so failed writes cannot advance state. */
  async appendPersistentEvent(event: HistoryEvent): Promise<void> {
    if (!this.#active) throw new Error("Нет активной сессии");
    const payload = encodeHistoryEvent(event);
    if (payload === undefined) throw new Error("Событие не является частью истории");
    await this.#store.append(this.#active.session.id, payload);
    this.#active.state.events.push(event);
  }

  async prepareUserMessage(content: string): Promise<PreparedUserMessage> {
    if (!this.#active) {
      const state = createAgentState(content);
      const payloads = state.events.map(encodeHistoryEvent).filter((item) => item !== undefined);
      const session = await this.#store.create({ task: content, payloads });
      this.#active = { state, session, historyObserver: this.#observer(session.id) };
      return { ...this.#active, created: true };
    }

    const event = { type: "user" as const, content };
    await this.appendPersistentEvent(event);
    return { ...this.#active, created: false };
  }

  reset(): void {
    this.#active = undefined;
  }

  #observer(sessionId: string): AgentObserver {
    return {
      onEvent: async (event) => {
        const payload = encodeHistoryEvent(event);
        if (payload !== undefined) await this.#store.append(sessionId, payload);
      },
    };
  }
}

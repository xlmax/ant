import type { AgentEvent, AgentObserver } from "@ant/core";

export type AgentLifecycleState = "idle" | "working" | "waiting_user" | "error" | "stopped";

/** Best-effort projection of ANT-owned lifecycle state into the terminal title. */
export interface AgentPresence {
  setState(state: AgentLifecycleState): void;
  setSession(sessionId: string): void;
  dispose(): void;
}

export interface AgentPresenceOptions {
  write?: (text: string) => void;
  isTTY?: boolean;
}

function stripTerminalControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("");
}

function lifecycleTitle(state: AgentLifecycleState): string {
  switch (state) {
    case "idle":
      return "ANT";
    case "working":
      return "ANT · working";
    case "waiting_user":
      return "ANT · waiting";
    case "error":
      return "ANT · error";
    case "stopped":
      return "ANT · stopped";
  }
}

export class NoopAgentPresence implements AgentPresence {
  setState(): void {}
  setSession(): void {}
  dispose(): void {}
}

export class OscAgentPresence implements AgentPresence {
  readonly #write: (text: string) => void;
  #lastTitle = "";

  constructor(write: (text: string) => void) {
    this.#write = write;
  }

  setState(state: AgentLifecycleState): void {
    const title = stripTerminalControls(lifecycleTitle(state));
    if (title === this.#lastTitle) return;
    this.#lastTitle = title;
    try {
      this.#write(`\u001B]0;${title}\u0007`);
    } catch {
      // Presence must never affect ANT execution.
    }
  }

  setSession(): void {}
  dispose(): void {}
}

/** Create the universal TTY title adapter, or a no-op for redirected output. */
export function createAgentPresence(options: AgentPresenceOptions = {}): AgentPresence {
  try {
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;
    if (!isTTY) return new NoopAgentPresence();
    const write = options.write ?? ((text: string) => process.stdout.write(text));
    return new OscAgentPresence(write);
  } catch {
    return new NoopAgentPresence();
  }
}

/** Single ANT-owned lifecycle. Presence failures are isolated at this boundary. */
export class AgentLifecycle implements AgentObserver {
  readonly #presence: AgentPresence;
  #state: AgentLifecycleState = "idle";
  #started = false;
  #stopped = false;
  #sessionId: string | undefined;

  constructor(presence: AgentPresence) {
    this.#presence = presence;
  }

  get state(): AgentLifecycleState {
    return this.#state;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#publishState();
  }

  markWorking(): void {
    this.#transition("working");
  }

  markIdle(): void {
    this.#transition("idle");
  }

  markFatalError(): void {
    this.#transition("error");
  }

  setSession(sessionId: string): void {
    if (this.#stopped || sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    try {
      this.#presence.setSession(sessionId);
    } catch {
      // Presence must never affect ANT execution.
    }
  }

  async waitForUser<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#state;
    this.#transition("waiting_user");
    try {
      return await operation();
    } finally {
      if (!this.#stopped && this.#state === "waiting_user") this.#transition(previous);
    }
  }

  onEvent(event: AgentEvent): void {
    if (
      event.type === "verification" ||
      event.type.startsWith("model.") ||
      event.type.startsWith("tool.")
    ) {
      this.markWorking();
    }
  }

  stop(): void {
    if (this.#stopped) return;
    if (this.#started) this.#transition("stopped");
    else this.#state = "stopped";
    this.#stopped = true;
    try {
      this.#presence.dispose();
    } catch {
      // Presence cleanup must never affect ANT shutdown.
    }
  }

  #transition(state: AgentLifecycleState): void {
    if (this.#stopped || (this.#started && state === this.#state)) return;
    this.#state = state;
    this.#started = true;
    this.#publishState();
  }

  #publishState(): void {
    try {
      this.#presence.setState(this.#state);
    } catch {
      // Presence must never affect ANT execution.
    }
  }
}

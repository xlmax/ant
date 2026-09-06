import { spawn } from "node:child_process";

import type { AgentEvent, AgentObserver } from "@ant/core";

export type AgentLifecycleState = "idle" | "working" | "waiting_user" | "error" | "stopped";

/** Best-effort projection of ANT-owned lifecycle state into an external host. */
export interface AgentPresence {
  setState(state: AgentLifecycleState): void;
  setSession(sessionId: string): void;
  dispose(): void;
}

export interface AgentPresenceEnvironment {
  readonly HERDR_ENV?: string;
  readonly HERDR_PANE_ID?: string;
  readonly HERDR_BIN_PATH?: string;
  readonly HERDR_SOCKET_PATH?: string;
  readonly ORCA_PANE_KEY?: string;
  readonly TERM_PROGRAM?: string;
}

export type PresenceCommandRunner = (command: string, args: readonly string[]) => void;

export interface AgentPresenceOptions {
  environment?: AgentPresenceEnvironment;
  write?: (text: string) => void;
  isTTY?: boolean;
  runCommand?: PresenceCommandRunner;
  nextSequence?: () => string;
}

const HERDR_SOURCE = "custom:ant";
const HERDR_AGENT = "ant";
let lastHerdrSequence = 0n;

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

function nextHerdrSequence(): string {
  const candidate = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  lastHerdrSequence = candidate > lastHerdrSequence ? candidate : lastHerdrSequence + 1n;
  return String(lastHerdrSequence);
}

/** Spawn a detached presence notification while absorbing sync and async process failures. */
export function runPresenceCommand(
  command: string,
  args: readonly string[],
  spawnProcess: typeof spawn = spawn,
): void {
  try {
    const child = spawnProcess(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {});
    child.unref();
  } catch {
    // Presence must never affect ANT execution.
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

interface OrcaAgentStatus {
  state: "working" | "blocked" | "done";
  prompt: string;
  agentType: "ant";
  interrupted?: true;
  sessionBoundary?: true;
}

function orcaStatus(state: AgentLifecycleState): OrcaAgentStatus {
  switch (state) {
    case "working":
      return { state: "working", prompt: "", agentType: "ant" };
    case "waiting_user":
      return { state: "blocked", prompt: "", agentType: "ant" };
    case "error":
      return { state: "done", prompt: "", agentType: "ant", interrupted: true };
    case "stopped":
      return { state: "done", prompt: "", agentType: "ant", sessionBoundary: true };
    case "idle":
      return { state: "done", prompt: "", agentType: "ant" };
  }
}

/** Orca's structured agent-status channel carried by OSC 9999. */
export class OrcaAgentPresence implements AgentPresence {
  readonly #write: (text: string) => void;

  constructor(write: (text: string) => void) {
    this.#write = write;
  }

  setState(state: AgentLifecycleState): void {
    try {
      this.#write(`\u001B]9999;${JSON.stringify(orcaStatus(state))}\u0007`);
    } catch {
      // Presence must never affect ANT execution.
    }
  }

  setSession(): void {}
  dispose(): void {}
}

export class HerdrAgentPresence implements AgentPresence {
  readonly #paneId: string;
  readonly #command: string;
  readonly #runCommand: PresenceCommandRunner;
  readonly #nextSequence: () => string;
  #sessionId: string | undefined;
  #released = false;

  constructor(options: {
    paneId: string;
    command: string;
    runCommand: PresenceCommandRunner;
    nextSequence: () => string;
  }) {
    this.#paneId = options.paneId;
    this.#command = options.command;
    this.#runCommand = options.runCommand;
    this.#nextSequence = options.nextSequence;
  }

  setState(state: AgentLifecycleState): void {
    if (state === "stopped") {
      this.#release();
      return;
    }
    const herdrState = state === "waiting_user" ? "blocked" : state === "error" ? "unknown" : state;
    const args = [
      "pane",
      "report-agent",
      this.#paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
      "--state",
      herdrState,
      "--seq",
      this.#nextSequence(),
    ];
    if (state === "waiting_user") args.push("--message", "waiting for user input");
    if (this.#sessionId) args.push("--agent-session-id", this.#sessionId);
    this.#run(args);
  }

  setSession(sessionId: string): void {
    if (this.#released) return;
    const normalized = stripTerminalControls(sessionId).trim().slice(0, 512);
    if (normalized === "" || normalized === this.#sessionId) return;
    this.#sessionId = normalized;
    this.#run([
      "pane",
      "report-agent-session",
      this.#paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
      "--seq",
      this.#nextSequence(),
      "--agent-session-id",
      normalized,
    ]);
  }

  dispose(): void {
    this.#release();
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#run([
      "pane",
      "release-agent",
      this.#paneId,
      "--source",
      HERDR_SOURCE,
      "--agent",
      HERDR_AGENT,
      "--seq",
      this.#nextSequence(),
    ]);
  }

  #run(args: readonly string[]): void {
    if (this.#released && args[1] !== "release-agent") return;
    try {
      this.#runCommand(this.#command, args);
    } catch {
      // Presence must never affect ANT execution.
    }
  }
}

class CompositeAgentPresence implements AgentPresence {
  readonly #delegates: readonly AgentPresence[];

  constructor(delegates: readonly AgentPresence[]) {
    this.#delegates = delegates;
  }

  setState(state: AgentLifecycleState): void {
    for (const delegate of this.#delegates) {
      try {
        delegate.setState(state);
      } catch {
        // One host must not prevent another fallback from being updated.
      }
    }
  }

  setSession(sessionId: string): void {
    for (const delegate of this.#delegates) {
      try {
        delegate.setSession(sessionId);
      } catch {
        // Session metadata is best-effort only.
      }
    }
  }

  dispose(): void {
    for (const delegate of this.#delegates) {
      try {
        delegate.dispose();
      } catch {
        // Presence cleanup is best-effort only.
      }
    }
  }
}

function isOrcaTerminal(environment: AgentPresenceEnvironment): boolean {
  return (
    environment.TERM_PROGRAM?.trim().toLowerCase() === "orca" ||
    (environment.ORCA_PANE_KEY?.trim() ?? "") !== ""
  );
}

function herdrEndpoint(
  environment: AgentPresenceEnvironment,
): { paneId: string; command: string } | undefined {
  if (environment.HERDR_ENV !== "1") return undefined;
  const paneId = environment.HERDR_PANE_ID?.trim() ?? "";
  const binary = environment.HERDR_BIN_PATH?.trim() ?? "";
  const socket = environment.HERDR_SOCKET_PATH?.trim() ?? "";
  if (paneId === "" || (binary === "" && socket === "")) return undefined;
  return { paneId, command: binary === "" ? "herdr" : binary };
}

/** Create terminal fallbacks plus host-specific Orca and Herdr presence adapters. */
export function createAgentPresence(options: AgentPresenceOptions = {}): AgentPresence {
  try {
    const environment = options.environment ?? process.env;
    const delegates: AgentPresence[] = [];
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;
    if (isTTY) {
      const write = options.write ?? ((text: string) => process.stdout.write(text));
      if (isOrcaTerminal(environment)) delegates.push(new OrcaAgentPresence(write));
      delegates.push(new OscAgentPresence(write));
    }

    const endpoint = herdrEndpoint(environment);
    if (endpoint) {
      delegates.push(
        new HerdrAgentPresence({
          ...endpoint,
          runCommand: options.runCommand ?? ((command, args) => runPresenceCommand(command, args)),
          nextSequence: options.nextSequence ?? nextHerdrSequence,
        }),
      );
    }

    if (delegates.length === 0) return new NoopAgentPresence();
    return new CompositeAgentPresence(delegates);
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

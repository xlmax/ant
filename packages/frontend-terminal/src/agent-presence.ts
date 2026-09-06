import { spawn } from "node:child_process";

export type AgentLifecycleState = "idle" | "working" | "waiting_user" | "error" | "stopped";

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
}

export interface AgentPresenceOptions {
  environment?: AgentPresenceEnvironment;
  write?: (text: string) => void;
  isTTY?: boolean;
  runCommand?: (command: string, args: readonly string[]) => void;
}

const SOURCE = "custom:ant";
const AGENT = "ant";

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0);
      return code !== undefined && code >= 0x20 && code !== 0x7f;
    })
    .join("");
}

function normalizeTitle(value: string): string {
  const collapsed = stripControlCharacters(value).replace(/\s+/gu, " ").trim();
  return collapsed === "" ? "ANT" : collapsed;
}

function renderTitle(state: AgentLifecycleState): string {
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

function escapeOscPayload(value: string): string {
  return stripControlCharacters(value).replaceAll("\u001B", "");
}

class NoopAgentPresence implements AgentPresence {
  setState(): void {}
  setSession(): void {}
  dispose(): void {}
}

class OscAgentPresence implements AgentPresence {
  readonly #write: (text: string) => void;
  #lastTitle = "";

  constructor(write: (text: string) => void) {
    this.#write = write;
  }

  setState(state: AgentLifecycleState): void {
    const nextTitle = normalizeTitle(renderTitle(state));
    if (nextTitle === this.#lastTitle) return;
    this.#lastTitle = nextTitle;
    const payload = escapeOscPayload(nextTitle);
    try {
      this.#write(`\u001B]0;${payload}\u0007`);
      this.#write(`\u001B]2;${payload}\u0007`);
    } catch {
      // Presence is best-effort only.
    }
  }

  setSession(): void {}

  dispose(): void {}
}

class HerdrAgentPresence implements AgentPresence {
  readonly #environment: AgentPresenceEnvironment;
  readonly #runCommand: (command: string, args: readonly string[]) => void;
  readonly #osc: OscAgentPresence;
  readonly #paneId: string;
  readonly #binPath: string;
  #seq = 0;
  #sessionId: string | undefined;
  #released = false;

  constructor(
    environment: AgentPresenceEnvironment,
    write: (text: string) => void,
    runCommand: (command: string, args: readonly string[]) => void,
  ) {
    this.#environment = environment;
    this.#runCommand = runCommand;
    this.#osc = new OscAgentPresence(write);
    this.#paneId = environment.HERDR_PANE_ID?.trim() ?? "";
    this.#binPath = environment.HERDR_BIN_PATH?.trim() ?? "";
  }

  setState(state: AgentLifecycleState): void {
    this.#osc.setState(state);
    if (state === "stopped") {
      this.#release();
      return;
    }

    const herdrState = state === "waiting_user" ? "blocked" : state === "error" ? "unknown" : state;
    this.#reportAgent(herdrState, state === "waiting_user" ? "waiting for user input" : undefined);
  }

  setSession(sessionId: string): void {
    if (this.#released) return;
    const normalized = sessionId.trim();
    if (normalized === "" || normalized === this.#sessionId) return;
    this.#sessionId = normalized;
    this.#reportSession(normalized);
  }

  dispose(): void {
    this.#release();
  }

  #allowed(): boolean {
    return this.#environment.HERDR_ENV === "1" && this.#paneId !== "" && this.#binPath !== "";
  }

  #nextSeq(): string {
    this.#seq += 1;
    return String(this.#seq);
  }

  #reportAgent(state: "idle" | "working" | "blocked" | "unknown", message?: string): void {
    if (this.#released || !this.#allowed()) return;
    const args = [
      "pane",
      "report-agent",
      this.#paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--state",
      state,
      "--seq",
      this.#nextSeq(),
    ];
    if (message) {
      args.push("--message", normalizeTitle(message));
    }
    if (this.#sessionId) {
      args.push("--agent-session-id", this.#sessionId);
    }
    try {
      this.#runCommand(this.#binPath, args);
    } catch {
      // Presence is best-effort only.
    }
  }

  #reportSession(sessionId: string): void {
    if (this.#released || !this.#allowed()) return;
    const args = [
      "pane",
      "report-agent-session",
      this.#paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--seq",
      this.#nextSeq(),
      "--agent-session-id",
      sessionId,
    ];
    try {
      this.#runCommand(this.#binPath, args);
    } catch {
      // Presence is best-effort only.
    }
  }

  #release(): void {
    if (this.#released || !this.#allowed()) return;
    this.#released = true;
    const args = [
      "pane",
      "release-agent",
      this.#paneId,
      "--source",
      SOURCE,
      "--agent",
      AGENT,
      "--seq",
      this.#nextSeq(),
    ];
    try {
      this.#runCommand(this.#binPath, args);
    } catch {
      // Presence is best-effort only.
    }
  }
}

function isHerdrEnvironment(environment: AgentPresenceEnvironment): boolean {
  return (
    environment.HERDR_ENV === "1" &&
    typeof environment.HERDR_PANE_ID === "string" &&
    environment.HERDR_PANE_ID.trim() !== "" &&
    typeof environment.HERDR_BIN_PATH === "string" &&
    environment.HERDR_BIN_PATH.trim() !== ""
  );
}

function defaultRunCommand(command: string, args: readonly string[]): void {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

export function createAgentPresence(options: AgentPresenceOptions = {}): AgentPresence {
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;

  if (isHerdrEnvironment(environment)) {
    return new HerdrAgentPresence(environment, write, runCommand);
  }
  if (isTTY) {
    return new OscAgentPresence(write);
  }
  return new NoopAgentPresence();
}

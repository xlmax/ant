import { execFile } from "node:child_process";
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { promisify } from "node:util";

import { checkForUpdates, isRunningUnderNpm, runGlobalUpdate } from "./updates/updates.js";
import { closeUserInputFrame, openUserInputFrame } from "./input-frame.js";
import type { InputHistory } from "./input-history.js";
import type {
  GitPresentationService,
  ProcessControl,
  TerminalPort,
  UpdateService,
} from "./presentation-ports.js";
import { readTerminalInput, usesCustomTerminalInput } from "./terminal-input.js";
import { TurnChangeTracker } from "./turn-change-summary.js";

const execFileAsync = promisify(execFile);

export class ConsoleTerminal implements TerminalPort {
  #readline: Interface | undefined;

  #getReadline(): Interface | undefined {
    if (usesCustomTerminalInput(process.platform, Boolean(stdin.isTTY))) return undefined;
    this.#readline ??= createInterface({ input: stdin, output: stdout });
    return this.#readline;
  }

  #closeReadline(): void {
    this.#readline?.close();
    this.#readline = undefined;
  }

  log(message: string): void {
    console.log(message);
  }
  warn(message: string): void {
    console.warn(message);
  }
  error(message: string): void {
    console.error(message);
  }
  write(message: string): void {
    stdout.write(message);
  }
  clear(): void {
    stdout.write("\u001B[2J\u001B[H");
  }
  async read(history: InputHistory, prompt: string): Promise<string | undefined> {
    openUserInputFrame();
    try {
      return await readTerminalInput(history, this.#getReadline(), prompt);
    } finally {
      closeUserInputFrame();
    }
  }
  async readSecret(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("Интерактивный ввод недоступен");
    this.#closeReadline();
    const { readHiddenTerminalInput } = await import("./terminal-secret-input.js");
    return readHiddenTerminalInput(prompt, signal === undefined ? {} : { signal });
  }
  async confirm(prompt: string, signal?: AbortSignal): Promise<boolean | undefined> {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("Интерактивный ввод недоступен");
    this.#closeReadline();
    const { readTerminalPrompt } = await import("./terminal-secret-input.js");
    const answer = await readTerminalPrompt(prompt, {
      hidden: false,
      ...(signal === undefined ? {} : { signal }),
    });
    if (answer === undefined) return undefined;
    const normalized = answer.trim().toLowerCase();
    if (normalized === "" || normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    throw new Error("Введите Y или N.");
  }
  close(): void {
    this.#closeReadline();
  }
}

export const nodeProcessControl: ProcessControl = {
  onInterrupt(listener) {
    process.on("SIGINT", listener);
    return () => process.removeListener("SIGINT", listener);
  },
  timeout: (milliseconds) => AbortSignal.timeout(milliseconds),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export const globalUpdateService: UpdateService = {
  managedByNpm: isRunningUnderNpm(),
  check: checkForUpdates,
  install: runGlobalUpdate,
};

export const gitPresentationService: GitPresentationService = {
  async branch(workspace) {
    try {
      const { stdout: branchOutput } = await execFileAsync("git", ["branch", "--show-current"], {
        cwd: workspace,
        encoding: "utf8",
      });
      const branch = branchOutput.trim();
      return branch === "" ? undefined : branch;
    } catch {
      return undefined;
    }
  },
  createChangeTracker: (workspace) => new TurnChangeTracker(workspace),
};

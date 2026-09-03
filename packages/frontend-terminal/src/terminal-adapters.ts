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
  readonly #readline: Interface | undefined;

  constructor() {
    this.#readline = usesCustomTerminalInput(process.platform, Boolean(stdin.isTTY))
      ? undefined
      : createInterface({ input: stdin, output: stdout });
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
  async read(history: InputHistory, prompt: string): Promise<string> {
    openUserInputFrame();
    try {
      return await readTerminalInput(history, this.#readline, prompt);
    } finally {
      closeUserInputFrame();
    }
  }
  close(): void {
    this.#readline?.close();
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

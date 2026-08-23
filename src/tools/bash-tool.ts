import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import type { Tool } from "../core/environment.js";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;

interface BashInput {
  command: string;
  timeout?: number;
}

function parseInput(input: unknown): BashInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string" ||
    input.command.trim() === ""
  ) {
    throw new Error("bash expects an object with a non-empty string property 'command'");
  }

  const source = input as Record<string, unknown>;
  const timeout = source.timeout;

  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout <= 0)
  ) {
    throw new Error("bash timeout must be a positive number of seconds");
  }

  return {
    command: input.command,
    ...(typeof timeout === "number" ? { timeout } : {}),
  };
}

function shellConfiguration(bashPath?: string): { shell: string; args: string[] } {
  if (process.platform !== "win32") {
    return { shell: bashPath ?? "bash", args: ["-c"] };
  }

  const candidates = [
    bashPath,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
    "bash.exe",
  ];

  for (const candidate of candidates) {
    if (candidate && (candidate === "bash.exe" || existsSync(candidate))) {
      return { shell: candidate, args: ["-c"] };
    }
  }

  throw new Error("bash executable was not found; configure tools.bashPath");
}

function truncateOutput(output: string): { output: string; truncated: boolean } {
  let result = output;
  let truncated = false;
  const bytes = Buffer.byteLength(result, "utf8");

  if (bytes > MAX_BYTES) {
    result = Buffer.from(result, "utf8").subarray(bytes - MAX_BYTES).toString("utf8");
    truncated = true;
  }

  const lines = result.split("\n");

  if (lines.length > MAX_LINES) {
    result = lines.slice(-MAX_LINES).join("\n");
    truncated = true;
  }

  return { output: result, truncated };
}

export function createBashTool(
  workspaceDirectory: string,
  bashPath?: string,
): Tool {
  return {
    spec: {
      name: "bash",
      description:
        "Execute a bash command in the workspace. Returns combined stdout and stderr. Output is truncated to the last 2,000 lines or 50 KiB. Optionally provide timeout in seconds.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<unknown> {
      const { command, timeout } = parseInput(input);
      signal?.throwIfAborted();
      const { shell, args } = shellConfiguration(bashPath);

      return new Promise((resolve, reject) => {
        const child = spawn(shell, [...args, command], {
          cwd: workspaceDirectory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let timedOut = false;
        let settled = false;
        const timeoutHandle =
          timeout === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill();
              }, timeout * 1_000);

        const cleanup = (): void => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          signal?.removeEventListener("abort", onAbort);
        };

        const finish = (callback: () => void): void => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          callback();
        };

        const onAbort = (): void => {
          child.kill();
          finish(() => reject(new Error("Operation aborted")));
        };

        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (exitCode) =>
          finish(() => {
            if (timedOut) {
              reject(new Error(`bash timed out after ${timeout} seconds`));
              return;
            }

            const result = truncateOutput(Buffer.concat(chunks).toString("utf8"));
            resolve({
              exitCode,
              output: result.output,
              truncated: result.truncated,
            });
          }),
        );

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}

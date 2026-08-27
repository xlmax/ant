import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { Tool } from "@ant/app";
import type { SingleToolOutputHandler } from "@ant/core";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const MAX_TIMEOUT_SECONDS = 3_600;

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
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    throw new Error("bash timeout must be a positive number of seconds");
  }

  if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`bash timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
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

function trimUtf8Boundary(buffer: Buffer, start: number): number {
  while (start < buffer.length) {
    const current = buffer[start];
    if (current === undefined) {
      return buffer.length;
    }

    if ((current & 0b10000000) === 0) {
      return start;
    }

    if ((current & 0b11100000) === 0b11000000 && start + 1 < buffer.length) {
      return start;
    }

    if ((current & 0b11110000) === 0b11100000 && start + 2 < buffer.length) {
      return start;
    }

    if ((current & 0b11111000) === 0b11110000 && start + 3 < buffer.length) {
      return start;
    }

    start += 1;
  }

  return buffer.length;
}

function truncateOutput(
  output: Buffer,
  previouslyTruncated = false,
): { output: string; truncated: boolean } {
  let resultBuffer = output;
  let truncated = previouslyTruncated;

  if (previouslyTruncated && resultBuffer.length > 0) {
    resultBuffer = resultBuffer.subarray(trimUtf8Boundary(resultBuffer, 0));
  }

  if (resultBuffer.length > MAX_BYTES) {
    const start = trimUtf8Boundary(resultBuffer, resultBuffer.length - MAX_BYTES);
    resultBuffer = resultBuffer.subarray(start);
    truncated = true;
  }

  const result = resultBuffer.toString("utf8");
  const lines = result.split("\n");

  if (lines.length > MAX_LINES) {
    return {
      output: lines.slice(-MAX_LINES).join("\n"),
      truncated: true,
    };
  }

  return { output: result, truncated };
}

class BoundedOutputBuffer {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  append(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;

    while (this.#bytes > MAX_BYTES && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      const excess = this.#bytes - MAX_BYTES;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
      this.#truncated = true;
    }
  }

  result(): { output: string; truncated: boolean } {
    return truncateOutput(Buffer.concat(this.#chunks, this.#bytes), this.#truncated);
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      taskkill.unref();
    } catch {
      // ignore
    }

    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ignore, process tree could already be dead
  }
}

export function createBashTool(workspaceDirectory: string, bashPath?: string): Tool {
  return {
    metadata: {
      ownerId: "ant.coding-tools",
      sideEffects: "process",
      parallelSafe: false,
      requiredCapabilities: ["process.spawn"],
    },
    spec: {
      name: "bash",
      description:
        "Execute a bash command in the workspace. Returns combined stdout and stderr. Output is truncated to the last 2,000 lines or 50 KiB. Optionally provide timeout in seconds, up to 3600.",
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

    async execute(
      input: unknown,
      signal?: AbortSignal,
      onOutput?: SingleToolOutputHandler,
    ): Promise<unknown> {
      const { command, timeout } = parseInput(input);
      signal?.throwIfAborted();
      const { shell, args } = shellConfiguration(bashPath);

      return new Promise((resolve, reject) => {
        const child = spawn(shell, [...args, command], {
          cwd: workspaceDirectory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        const output = new BoundedOutputBuffer();
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let timedOut = false;
        let settled = false;

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

        const terminate = (): void => {
          if (!child.pid) {
            return;
          }

          terminateProcessTree(child.pid);
        };

        const timeoutHandle =
          timeout === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                terminate();
              }, timeout * 1_000);

        const onAbort = (): void => {
          terminate();
          finish(() => reject(new Error("Operation aborted")));
        };

        child.stdout.on("data", (chunk: Buffer) => {
          output.append(chunk);
          const content = stdoutDecoder.write(chunk);
          if (content) onOutput?.({ stream: "stdout", content });
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output.append(chunk);
          const content = stderrDecoder.write(chunk);
          if (content) onOutput?.({ stream: "stderr", content });
        });
        child.stdout.on("end", () => {
          const content = stdoutDecoder.end();
          if (content) onOutput?.({ stream: "stdout", content });
        });
        child.stderr.on("end", () => {
          const content = stderrDecoder.end();
          if (content) onOutput?.({ stream: "stderr", content });
        });
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (exitCode) =>
          finish(() => {
            if (timedOut) {
              reject(new Error(`bash timed out after ${timeout} seconds`));
              return;
            }

            const result = output.result();
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

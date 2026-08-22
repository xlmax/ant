import { readFile } from "node:fs/promises";

import type { Tool } from "./environment.js";
import { parsePathInput, resolveToolPath } from "./path-utils.js";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
}

function parsePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function parseInput(input: unknown): ReadInput {
  const path = parsePathInput(input, "read");

  if (typeof input !== "object" || input === null) {
    throw new Error("read expects an object");
  }

  const source = input as Record<string, unknown>;
  const offset = parsePositiveInteger(source.offset, "read offset");
  const limit = parsePositiveInteger(source.limit, "read limit");

  return {
    path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function takeOutputLines(lines: readonly string[]): {
  lines: string[];
  truncatedByLimit: boolean;
} {
  const output: string[] = [];
  let bytes = 0;

  for (const line of lines) {
    const separatorBytes = output.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (
      output.length >= MAX_LINES ||
      bytes + separatorBytes + lineBytes > MAX_BYTES
    ) {
      return { lines: output, truncatedByLimit: true };
    }

    output.push(line);
    bytes += separatorBytes + lineBytes;
  }

  return { lines: output, truncatedByLimit: false };
}

export function createReadTool(workspaceDirectory: string): Tool {
  return {
    spec: {
      name: "read",
      description:
        "Read a text file. Paths may be relative to the workspace or absolute. Output is truncated to 2,000 lines or 50 KiB; use offset and limit to continue reading large files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: {
            type: "integer",
            description: "Line number to start reading from (1-indexed)",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<ReadResult> {
      signal?.throwIfAborted();
      const { path, offset = 1, limit } = parseInput(input);
      const content = await readFile(resolveToolPath(path, workspaceDirectory), "utf8");
      signal?.throwIfAborted();

      const allLines = content.split("\n");

      if (offset > allLines.length) {
        throw new Error(
          `read offset ${offset} is beyond the end of file (${allLines.length} lines total)`,
        );
      }

      const availableLines = allLines.slice(offset - 1);
      const requestedLines =
        limit === undefined ? availableLines : availableLines.slice(0, limit);
      const { lines, truncatedByLimit } = takeOutputLines(requestedLines);
      const endLine = offset + lines.length - 1;
      const hasMoreLines = endLine < allLines.length;
      const truncated = truncatedByLimit || hasMoreLines;

      return {
        path,
        content: lines.join("\n"),
        totalLines: allLines.length,
        startLine: offset,
        endLine,
        truncated,
        ...(truncated ? { nextOffset: endLine + 1 } : {}),
      };
    },
  };
}

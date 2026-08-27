import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Tool } from "../app/tools.js";
import { writeFileAtomically } from "../fs/atomic-write.js";
import { parsePathInput, resolveToolPath } from "./path-utils.js";

function parseInput(input: unknown): { path: string; content: string } {
  const path = parsePathInput(input, "write");

  if (
    typeof input !== "object" ||
    input === null ||
    !("content" in input) ||
    typeof input.content !== "string"
  ) {
    throw new Error("write expects an object with a string property 'content'");
  }

  return { path, content: input.content };
}

export function createWriteTool(workspaceDirectory: string): Tool {
  return {
    metadata: {
      ownerId: "ant.coding-tools",
      sideEffects: "workspace",
      parallelSafe: false,
      requiredCapabilities: ["filesystem.write"],
    },
    spec: {
      name: "write",
      description:
        "Create or overwrite a text file. Parent directories are created automatically. Use only for new files or complete rewrites.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<unknown> {
      signal?.throwIfAborted();
      const { path, content } = parseInput(input);
      const target = resolveToolPath(path, workspaceDirectory);

      await mkdir(dirname(target), { recursive: true });
      signal?.throwIfAborted();
      await writeFileAtomically(target, content);
      signal?.throwIfAborted();

      return {
        path,
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    },
  };
}

import { minimatch } from "minimatch";

import type { Tool } from "../app/tools.js";
import { walkFiles } from "./file-search.js";
import { resolveToolPath } from "./path-utils.js";

const MAX_RESULTS = 1_000;

interface GlobInput {
  pattern: string;
  path?: string;
}

function parseInput(input: unknown): GlobInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("glob expects an object");
  }

  const source = input as Record<string, unknown>;

  if (typeof source.pattern !== "string" || source.pattern.trim() === "") {
    throw new Error("glob expects a non-empty string property 'pattern'");
  }

  if (source.path !== undefined && typeof source.path !== "string") {
    throw new Error("glob path must be a string");
  }

  return {
    pattern: source.pattern,
    ...(source.path === undefined ? {} : { path: source.path }),
  };
}

export function createGlobTool(workspaceDirectory: string): Tool {
  return {
    metadata: {
      ownerId: "ant.coding-tools",
      sideEffects: "none",
      parallelSafe: true,
      requiredCapabilities: ["filesystem.read"],
    },
    spec: {
      name: "glob",
      description:
        "Find files in the workspace matching a glob pattern, for example 'src/**/*.ts' or '**/*.json'. Returns relative file paths sorted alphabetically. Skips .git, node_modules, and .ant directories.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match file paths against" },
          path: {
            type: "string",
            description:
              "Directory to search (relative to the workspace or absolute). Default: workspace root.",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },

    async execute(input: unknown, signal?: AbortSignal): Promise<unknown> {
      signal?.throwIfAborted();
      const options = parseInput(input);
      const root = resolveToolPath(options.path ?? ".", workspaceDirectory);
      const { files, truncated } = await walkFiles(root, signal, { maxFiles: 50_000 });

      const matching = files.filter((file) => minimatch(file, options.pattern, { dot: true }));
      const matches = matching.slice(0, MAX_RESULTS);

      return {
        matches,
        truncated: truncated || matching.length > MAX_RESULTS,
      };
    },
  };
}

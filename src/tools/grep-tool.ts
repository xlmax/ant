import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";

import type { Tool } from "../app/tools.js";
import { walkFiles } from "./file-search.js";
import { resolveToolPath } from "./path-utils.js";
import { RegexMatcher } from "./regex-matcher.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 500;
const REGEX_TIMEOUT_MS = 500;

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  maxResults?: number;
  ignoreCase?: boolean;
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

function parseInteger(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Math.min(value, max);
}

function parseInput(input: unknown): GrepInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("grep expects an object");
  }

  const source = input as Record<string, unknown>;

  if (typeof source.pattern !== "string" || source.pattern === "") {
    throw new Error("grep expects a non-empty string property 'pattern'");
  }

  if (source.path !== undefined && typeof source.path !== "string") {
    throw new Error("grep path must be a string");
  }

  if (source.include !== undefined && typeof source.include !== "string") {
    throw new Error("grep include must be a string");
  }

  if (source.ignoreCase !== undefined && typeof source.ignoreCase !== "boolean") {
    throw new Error("grep ignoreCase must be a boolean");
  }

  const maxResults = parseInteger(source.maxResults, "grep maxResults", MAX_RESULTS);

  return {
    pattern: source.pattern,
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(source.include === undefined ? {} : { include: source.include }),
    ...(source.ignoreCase === undefined ? {} : { ignoreCase: source.ignoreCase }),
    ...(maxResults === undefined ? {} : { maxResults }),
  };
}

function matchesInclude(relativePath: string, include: string): boolean {
  const pattern = include.includes("/") || include.startsWith("**") ? include : `**/${include}`;
  return minimatch(relativePath, pattern, { dot: true });
}

function truncateLine(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= MAX_LINE_CHARS) {
    return text;
  }

  return `${characters.slice(0, MAX_LINE_CHARS).join("")}…`;
}

export function createGrepTool(workspaceDirectory: string): Tool {
  return {
    metadata: {
      ownerId: "ant.coding-tools",
      sideEffects: "none",
      parallelSafe: true,
      requiredCapabilities: ["filesystem.read"],
    },
    spec: {
      name: "grep",
      description:
        "Search text files in the workspace for lines matching a regular expression. Returns the file path, 1-indexed line number, and the matching line for each result. Skips .git, node_modules, and .ant directories.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: {
            type: "string",
            description:
              "Directory to search (relative to the workspace or absolute). Default: workspace root.",
          },
          include: {
            type: "string",
            description: "Optional glob to filter file paths, e.g. 'src/**/*.ts'.",
          },
          maxResults: {
            type: "integer",
            description: "Maximum number of matches to return (default 100, maximum 500).",
          },
          ignoreCase: {
            type: "boolean",
            description: "Case-insensitive matching (default false).",
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

      let regex: RegExp;
      try {
        regex = new RegExp(options.pattern, options.ignoreCase ? "iu" : "u");
      } catch (error) {
        throw new Error(
          `grep received an invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      const include = options.include;
      const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
      const matcher = new RegexMatcher({
        pattern: regex.source,
        flags: regex.flags,
        maxResults,
        timeoutMs: REGEX_TIMEOUT_MS,
      });
      const { files, truncated: walkTruncated } = await walkFiles(root, signal);
      const matches: GrepMatch[] = [];
      let filesSearched = 0;
      let skippedFiles = 0;
      let truncated = walkTruncated;

      for (const relativePath of files) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        signal?.throwIfAborted();

        if (include !== undefined && !matchesInclude(relativePath, include)) {
          continue;
        }

        const absolutePath = join(root, relativePath);
        let metadata;
        try {
          metadata = await stat(absolutePath);
        } catch {
          skippedFiles += 1;
          continue;
        }

        if (metadata.size > MAX_FILE_BYTES) {
          skippedFiles += 1;
          continue;
        }

        let content: string;
        try {
          content = await readFile(absolutePath, "utf8");
        } catch {
          skippedFiles += 1;
          continue;
        }

        if (content.includes("\0")) {
          skippedFiles += 1;
          continue;
        }

        filesSearched += 1;
        const outcome = matcher.match(content);
        if (outcome.timedOut) {
          return {
            matches,
            truncated: true,
            filesSearched,
            skippedFiles,
            regexTimedOut: true,
            regexTimeoutPath: relativePath,
          };
        }

        const lines = content.split("\n");
        for (const lineNumber of outcome.lineNumbers) {
          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }

          const line = lines[lineNumber - 1] ?? "";
          matches.push({
            path: relativePath,
            line: lineNumber,
            text: truncateLine(line),
          });
        }
      }

      return {
        matches,
        truncated,
        filesSearched,
        skippedFiles,
      };
    },
  };
}

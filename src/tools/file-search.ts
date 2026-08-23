import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_SKIP_DIRECTORIES = new Set([".git", "node_modules", ".ant"]);

export interface WalkResult {
  files: string[];
  truncated: boolean;
}

export interface WalkOptions {
  maxFiles?: number;
  skipDirectories?: ReadonlySet<string>;
}

/**
 * Recursively collects regular files under `root`, returning paths relative to
 * `root` with forward slashes. Symbolic links and the default ignored
 * directories are skipped to avoid cycles and escaping the search root.
 */
export async function walkFiles(
  root: string,
  signal: AbortSignal | undefined,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? 10_000;
  const skipDirectories = options.skipDirectories ?? DEFAULT_SKIP_DIRECTORIES;
  const files: string[] = [];
  let truncated = false;

  const toRelative = (absolutePath: string): string =>
    relative(root, absolutePath).replaceAll("\\", "/");

  const visit = async (directory: string): Promise<void> => {
    if (truncated) {
      return;
    }
    signal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (truncated) {
        return;
      }
      signal?.throwIfAborted();

      const absolutePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) {
          await visit(absolutePath);
        }
      } else if (entry.isFile()) {
        files.push(toRelative(absolutePath));
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };

  await visit(root);
  return { files, truncated };
}

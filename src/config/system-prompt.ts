import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SystemPrompt } from "../app/system-prompt.js";

const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../../prompts/SYSTEM.md", import.meta.url));

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function loadSystemPrompt(
  workspace: string,
  additionalPaths: readonly string[] = [],
): Promise<SystemPrompt> {
  const candidates = [
    DEFAULT_PROMPT_PATH,
    resolve(homedir(), ".ant", "SYSTEM.md"),
    resolve(workspace, ".ant", "SYSTEM.md"),
    ...additionalPaths.map((path) => resolve(workspace, path)),
  ];
  const sources: string[] = [];
  const parts: string[] = [];

  for (const path of [...new Set(candidates)]) {
    const content = await readOptional(path);

    if (content) {
      sources.push(path);
      parts.push(content);
    }
  }

  if (parts.length === 0) {
    throw new Error("Не найден системный промпт");
  }

  return {
    content: parts.join("\n\n"),
    sources,
  };
}

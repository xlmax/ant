import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROMPT_PATH = fileURLToPath(
  new URL("../../prompts/SYSTEM.md", import.meta.url),
);

export interface SystemPrompt {
  content: string;
  sources: string[];
}

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

function configuredPaths(workspace: string): string[] {
  const value = process.env.AGENT_SYSTEM_PROMPT_PATHS;

  if (!value) {
    return [];
  }

  return value
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(workspace, path));
}

export async function loadSystemPrompt(
  workspace: string,
): Promise<SystemPrompt> {
  const candidates = [
    DEFAULT_PROMPT_PATH,
    resolve(homedir(), ".minimal-ai-agent", "SYSTEM.md"),
    resolve(workspace, ".agent", "SYSTEM.md"),
    ...configuredPaths(workspace),
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

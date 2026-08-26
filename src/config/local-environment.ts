import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

function loadOptionalEnv(path: string): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function applyLocalEnvironment(workspace: string): void {
  // Project first so it wins over the global fallback: loadEnvFile does not
  // overwrite already-set variables, and the real environment wins over both.
  loadOptionalEnv(resolve(workspace, ".env.local"));
  loadOptionalEnv(resolve(homedir(), ".ant", ".env.local"));
}

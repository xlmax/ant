import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function resolveToolPath(path: string, cwd: string): string {
  const expandedPath = expandHome(path);
  return isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(cwd, expandedPath);
}

export function parsePathInput(input: unknown, toolName: string): string {
  if (
    typeof input !== "object" ||
    input === null ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    input.path.trim() === ""
  ) {
    throw new Error(`${toolName} expects an object with a non-empty string property 'path'`);
  }

  if (input.path.includes("\0")) {
    throw new Error(`${toolName} path must not contain null bytes`);
  }

  return input.path;
}

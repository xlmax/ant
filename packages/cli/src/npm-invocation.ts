import { access } from "node:fs/promises";
import { basename, delimiter, dirname, resolve } from "node:path";

export interface NpmInvocation {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

function npmCliCandidates(environment: NodeJS.ProcessEnv, nodeExecutable: string): string[] {
  const candidates: string[] = [];
  const configured = environment.npm_execpath;
  if (configured && basename(configured).toLowerCase() === "npm-cli.js") {
    candidates.push(resolve(configured));
  }

  const directories = [
    dirname(nodeExecutable),
    ...(environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean),
  ];
  for (const directory of directories) {
    candidates.push(resolve(directory, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Returns an npm invocation that does not execute a Windows command shim directly. */
export async function resolveNpmInvocation(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeExecutable = process.execPath,
): Promise<NpmInvocation> {
  if (platform !== "win32") return { command: "npm", prefixArgs: [] };

  for (const candidate of npmCliCandidates(environment, nodeExecutable)) {
    try {
      await access(candidate);
      return { command: nodeExecutable, prefixArgs: ["--", candidate] };
    } catch {
      // Try the next Node/npm installation visible in PATH.
    }
  }

  throw new Error(
    "Не удалось найти npm-cli.js. Установите npm рядом с Node.js или добавьте его в PATH.",
  );
}

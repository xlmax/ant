import { spawn } from "node:child_process";

export interface UpdateInfo {
  version: string;
  url?: string;
}

const RELEASE_API_URL = "https://api.github.com/repos/xlmax/ant/releases/latest";

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => {
      const match = part.match(/^\d+/u);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
}

export function isNewer(latest: string, current: string): boolean {
  const left = parseVersion(latest);
  const right = parseVersion(current);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }

  return false;
}

export function parseLatestRelease(value: unknown): UpdateInfo | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || record.tag_name === "") {
    return undefined;
  }

  const version = record.tag_name.replace(/^v/u, "");
  const url = Array.isArray(record.assets)
    ? record.assets
        .map((asset) => {
          if (typeof asset !== "object" || asset === null) {
            return undefined;
          }

          const candidate = asset as Record<string, unknown>;
          if (
            typeof candidate.name === "string" &&
            candidate.name.startsWith("ant-") &&
            candidate.name.endsWith(".tgz") &&
            typeof candidate.browser_download_url === "string"
          ) {
            return candidate.browser_download_url;
          }

          return undefined;
        })
        .find((candidate): candidate is string => candidate !== undefined)
    : undefined;

  return { version, ...(url === undefined ? {} : { url }) };
}

export async function fetchLatestRelease(signal?: AbortSignal): Promise<UpdateInfo | undefined> {
  try {
    const response = await fetch(RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ant",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload: unknown = await response.json();
    return parseLatestRelease(payload);
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<UpdateInfo | undefined> {
  const latest = await fetchLatestRelease(signal);
  if (!latest || !isNewer(latest.version, currentVersion)) {
    return undefined;
  }

  return latest;
}

export function isRunningUnderNpm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_lifecycle_event !== undefined || env.npm_execpath !== undefined;
}

export function runGlobalUpdate(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmCommand, ["install", "-g", url], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`npm install завершился с кодом ${exitCode ?? "неизвестно"}`));
      }
    });
  });
}

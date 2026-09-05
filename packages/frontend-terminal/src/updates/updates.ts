import { spawn } from "node:child_process";

import type { UpdateInfo, UpdateInstallResult } from "../presentation-ports.js";

export interface GlobalUpdateRuntime {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly writeStdout?: (chunk: Buffer) => void;
  readonly writeStderr?: (chunk: Buffer) => void;
}

const RELEASE_API_URL = "https://api.github.com/repos/xlmax/ant/releases/latest";
const RELEASE_REPOSITORY_PATH = "/xlmax/ant/releases/download";

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => {
      const match = part.match(/^\d+/u);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
}

export function isTrustedReleaseAssetUrl(url: string, version: string): boolean {
  try {
    const parsed = new URL(url);
    const expected = `https://github.com${RELEASE_REPOSITORY_PATH}/v${version}/ant-${version}.tgz`;
    return (
      url === expected &&
      parsed.href === expected &&
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname === `${RELEASE_REPOSITORY_PATH}/v${version}/ant-${version}.tgz`
    );
  } catch {
    return false;
  }
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
            candidate.name === `ant-${version}.tgz` &&
            typeof candidate.browser_download_url === "string" &&
            isTrustedReleaseAssetUrl(candidate.browser_download_url, version)
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

export function isLoadedKoffiBusyError(stderr: string): boolean {
  return /\bEBUSY\b/iu.test(stderr) && /koffi\.node/iu.test(stderr);
}

export function runGlobalUpdate(
  url: string,
  runtime: GlobalUpdateRuntime = {},
): Promise<UpdateInstallResult> {
  if (!isTrustedReleaseAssetUrl(url, url.match(/\/ant-(\d+(?:\.\d+)+)\.tgz$/u)?.[1] ?? "")) {
    return Promise.reject(new Error("Недоверенный URL установочного файла обновления"));
  }

  return new Promise((resolve, reject) => {
    const isWindows = (runtime.platform ?? process.platform) === "win32";
    const command = isWindows ? "cmd.exe" : "npm";
    const args = isWindows
      ? ["/d", "/s", "/c", "npm.cmd", "install", "-g", url]
      : ["install", "-g", url];
    const child = (runtime.spawnProcess ?? spawn)(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (runtime.writeStdout) runtime.writeStdout(chunk);
      else process.stdout.write(chunk);
    });

    // Windows может удерживать загруженную koffi.node до завершения ANT.
    // Буфер позволяет передать этот известный случай команде без шумного stderr.
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    let spawnFailed = false;
    child.on("error", (error) => {
      spawnFailed = true;
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (spawnFailed) return;
      if (exitCode === 0) {
        resolve({ status: "updated" });
        return;
      }

      const stderr = Buffer.concat(stderrChunks);
      if (isWindows && isLoadedKoffiBusyError(stderr.toString("utf8"))) {
        resolve({ status: "blocked-by-loaded-native-module" });
        return;
      }

      if (stderr.length > 0) {
        if (runtime.writeStderr) runtime.writeStderr(stderr);
        else process.stderr.write(stderr);
      }
      reject(new Error(`npm install завершился с кодом ${exitCode ?? "неизвестно"}`));
    });
  });
}

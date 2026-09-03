import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialStoreErrorKind = "corrupt" | "read" | "write";

export class CredentialStoreError extends Error {
  readonly kind: CredentialStoreErrorKind;

  constructor(kind: CredentialStoreErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialStoreError";
    this.kind = kind;
  }
}

interface CredentialFile {
  deepseek?: {
    apiKey?: string;
  };
}

export function defaultCredentialPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    platform === "win32"
      ? (environment.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(root, "ant", "credentials.json");
}

function parseCredentialFile(content: string): CredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CredentialStoreError("corrupt", "ANT credentials file contains invalid JSON.", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreError("corrupt", "ANT credentials file has an invalid format.");
  }
  const deepseek = (parsed as Record<string, unknown>).deepseek;
  if (deepseek === undefined) return {};
  if (typeof deepseek !== "object" || deepseek === null || Array.isArray(deepseek)) {
    throw new CredentialStoreError("corrupt", "ANT credentials file has an invalid format.");
  }
  const apiKey = (deepseek as Record<string, unknown>).apiKey;
  if (apiKey === undefined) return { deepseek: {} };
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new CredentialStoreError("corrupt", "Stored DeepSeek API key is empty or invalid.");
  }
  return { deepseek: { apiKey: apiKey.trim() } };
}

export class FileCredentialStore {
  readonly path: string;

  constructor(path = defaultCredentialPath()) {
    this.path = path;
  }

  async readDeepSeekKey(): Promise<string | undefined> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CredentialStoreError("read", "Unable to read ANT credentials file.", {
        cause: error,
      });
    }
    return parseCredentialFile(content).deepseek?.apiKey;
  }

  async writeDeepSeekKey(apiKey: string): Promise<void> {
    const normalized = apiKey.trim();
    if (normalized === "") throw new CredentialStoreError("write", "API key must not be empty.");

    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.credentials-${process.pid}-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const created = await mkdir(directory, { recursive: true, mode: 0o700 });
      if (created !== undefined && process.platform !== "win32") await chmod(directory, 0o700);
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ deepseek: { apiKey: normalized } }, undefined, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      temporaryCreated = true;
      if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError("write", "Unable to save ANT credentials file.", {
        cause: error,
      });
    }
  }

  async clearDeepSeekKey(): Promise<boolean> {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CredentialStoreError("write", "Unable to clear ANT credentials file.", {
        cause: error,
      });
    }
  }
}

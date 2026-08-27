import { chmod, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const RENAME_RETRY_DELAYS_MS = [50, 100, 200];

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * Windows can transiently refuse a rename with EPERM/EACCES/EBUSY while the
 * destination is briefly locked (for example by antivirus scanning). Retrying
 * with a short delay turns these spurious failures into successful writes.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isTransientRenameError(error)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  await rename(from, to);
}

export async function writeFileAtomically(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  let mode: number | undefined;

  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, content);
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    await renameWithRetry(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

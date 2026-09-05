import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { resolveNpmInvocation } from "../npm-invocation.js";
import type { PluginPermission } from "../plugin-api.js";
import { parsePluginManifest } from "./manifest.js";
import { FilePluginRegistry, type InstalledPluginRecord } from "./plugin-registry.js";

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  if (code !== 0) throw new Error(`Plugin package operation failed: ${stderr.trim()}`);
  return stdout;
}

async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Plugin packages may not contain symbolic links");
    if (stat.isDirectory()) await assertNoSymlinks(path);
  }
}

async function topLevelPackages(nodeModules: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const child of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (child.isDirectory()) result.push(join(nodeModules, entry.name, child.name));
      }
    } else {
      result.push(join(nodeModules, entry.name));
    }
  }
  return result;
}

async function findPluginPackage(nodeModules: string): Promise<string> {
  const matches: string[] = [];
  for (const directory of await topLevelPackages(nodeModules)) {
    try {
      await readFile(join(directory, "ant-plugin.json"));
      matches.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (matches.length !== 1) {
    throw new Error("Installed source must contain exactly one top-level ant-plugin.json");
  }
  return matches[0] ?? "";
}

export class PluginInstaller {
  readonly #registry: FilePluginRegistry;

  constructor(readonly root: string) {
    this.#registry = new FilePluginRegistry(root);
  }

  async install(
    source: string,
    approvedPermissions: readonly PluginPermission[],
  ): Promise<InstalledPluginRecord> {
    await mkdir(join(this.root, ".staging"), { recursive: true });
    const staging = await mkdtemp(join(this.root, ".staging", "install-"));
    let backup: string | undefined;
    let target: string | undefined;
    try {
      const npm = await resolveNpmInvocation();
      const packedOutput = await run(
        npm.command,
        [
          ...npm.prefixArgs,
          "pack",
          resolve(source),
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          staging,
        ],
        staging,
      );
      const packed = JSON.parse(packedOutput) as Array<{ filename?: string }>;
      const filename = packed[0]?.filename;
      if (typeof filename !== "string") throw new Error("npm pack did not return a tarball");
      const installRoot = join(staging, "install");
      await mkdir(installRoot, { recursive: true });
      await run(
        npm.command,
        [
          ...npm.prefixArgs,
          "install",
          "--ignore-scripts",
          "--omit=dev",
          "--no-package-lock",
          "--no-save",
          "--prefix",
          installRoot,
          join(staging, basename(filename)),
        ],
        installRoot,
      );
      const installedNodeModules = join(installRoot, "node_modules");
      const packageRoot = await findPluginPackage(installedNodeModules);
      await rm(join(installedNodeModules, ".bin"), { recursive: true, force: true });
      await assertNoSymlinks(installedNodeModules);
      const manifest = parsePluginManifest(
        JSON.parse(await readFile(join(packageRoot, "ant-plugin.json"), "utf8")),
      );
      const approved = new Set(approvedPermissions);
      if (manifest.permissions.some((permission) => !approved.has(permission))) {
        throw new Error(`Explicit approval is required for every plugin permission`);
      }
      if (approvedPermissions.some((permission) => !manifest.permissions.includes(permission))) {
        throw new Error("Approved permissions must match the plugin manifest");
      }
      const candidate = join(staging, "candidate");
      await cp(packageRoot, candidate, { recursive: true, errorOnExist: true });
      await cp(installedNodeModules, join(candidate, "node_modules"), { recursive: true });
      await mkdir(join(this.root, "packages"), { recursive: true });
      target = join(this.root, "packages", manifest.id);
      try {
        await lstat(target);
        backup = join(staging, `previous-${randomUUID()}`);
        await rename(target, backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(candidate, target);
      } catch (error) {
        if (backup !== undefined) await rename(backup, target);
        throw error;
      }
      const record: InstalledPluginRecord = {
        id: manifest.id,
        version: manifest.version,
        source: resolve(source),
        approvedPermissions: [...manifest.permissions],
        enabled: true,
      };
      try {
        await this.#registry.upsert(record);
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (backup !== undefined) await rename(backup, target);
        throw error;
      }
      return record;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async remove(id: string): Promise<string> {
    const current = await this.#registry.get(id);
    if (current === undefined) throw new Error(`Plugin is not installed: ${id}`);
    const target = join(this.root, "packages", id);
    const trash = join(this.root, ".trash", `${id}-${Date.now()}-${randomUUID()}`);
    await mkdir(join(this.root, ".trash"), { recursive: true });
    await rename(target, trash);
    try {
      await this.#registry.remove(id);
    } catch (error) {
      await rename(trash, target);
      throw error;
    }
    return trash;
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPluginRecord> {
    return this.#registry.setEnabled(id, enabled);
  }
}

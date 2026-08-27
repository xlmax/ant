import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PluginPermission } from "../plugin-api.js";
import { writeFileAtomically } from "../atomic-write.js";

export interface InstalledPluginRecord {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly approvedPermissions: readonly PluginPermission[];
  readonly enabled: boolean;
}

interface RegistryFile {
  readonly schemaVersion: 1;
  readonly plugins: readonly InstalledPluginRecord[];
}

export class FilePluginRegistry {
  readonly #path: string;

  constructor(readonly root: string) {
    this.#path = join(root, "registry.json");
  }

  async list(): Promise<readonly InstalledPluginRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as RegistryFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
        throw new Error("Plugin registry has an unsupported schema");
      }
      const ids = parsed.plugins.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) {
        throw new Error("Plugin registry contains duplicate plugin ids");
      }
      return [...parsed.plugins].sort((left, right) => left.id.localeCompare(right.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async get(id: string): Promise<InstalledPluginRecord | undefined> {
    return (await this.list()).find((plugin) => plugin.id === id);
  }

  async upsert(record: InstalledPluginRecord): Promise<void> {
    const plugins = (await this.list()).filter(({ id }) => id !== record.id);
    plugins.push({ ...record, approvedPermissions: [...record.approvedPermissions] });
    await this.#write(plugins);
  }

  async remove(id: string): Promise<void> {
    await this.#write((await this.list()).filter((plugin) => plugin.id !== id));
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPluginRecord> {
    const current = await this.get(id);
    if (current === undefined) throw new Error(`Plugin is not installed: ${id}`);
    const updated = { ...current, enabled };
    await this.upsert(updated);
    return updated;
  }

  async #write(plugins: readonly InstalledPluginRecord[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const content = `${JSON.stringify({ schemaVersion: 1, plugins }, undefined, 2)}\n`;
    await writeFileAtomically(this.#path, content);
  }
}

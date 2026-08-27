import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ConfigurationRegistry } from "../app/configuration-registry.js";
import type {
  ConfigurationContext,
  ConfigurationKey,
  ConfigurationLayer,
  ConfigurationSection,
  ConfigurationSnapshot,
} from "../app/configuration-section.js";
import { writeFileAtomically } from "../fs/atomic-write.js";

const ROOT_SCHEMA_VERSION = 1;

interface RawSection {
  version: number;
  value: unknown;
}

interface RawLayer {
  sections: Map<string, RawSection>;
  source: string;
  layer: ConfigurationLayer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPath(value: unknown, path: string): boolean {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

function deletePath(value: unknown, path: string): void {
  const parts = path.split(".");
  let current = value;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current) || !isRecord(current[part])) return;
    current = current[part];
  }
  if (isRecord(current)) delete current[parts.at(-1) ?? ""];
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function deepMerge(base: unknown, update: unknown): unknown {
  if (!isRecord(base) || !isRecord(update)) return clone(update);
  const result: Record<string, unknown> = { ...(clone(base) as Record<string, unknown>) };
  for (const [key, value] of Object.entries(update)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Файл настроек ${path} содержит некорректный JSON`);
  }
  if (!isRecord(value)) throw new Error(`Файл настроек ${path} должен содержать JSON-объект`);
  return value;
}

function parseEnvelope(
  value: Record<string, unknown>,
  source: string,
  layer: ConfigurationLayer,
  registry: ConfigurationRegistry,
): RawLayer {
  const sections = new Map<string, RawSection>();
  if ("schemaVersion" in value || "sections" in value) {
    if (value.schemaVersion !== ROOT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported configuration schema version in ${source}: ${String(value.schemaVersion)}`,
      );
    }
    if (!isRecord(value.sections))
      throw new Error(`Configuration sections in ${source} must be an object`);
    for (const [namespace, raw] of Object.entries(value.sections)) {
      if (registry.find(namespace) === undefined) {
        throw new Error(`Unknown configuration namespace ${namespace} in ${source}`);
      }
      if (!isRecord(raw) || !Number.isInteger(raw.version) || !("value" in raw)) {
        throw new Error(`Invalid configuration section ${namespace} in ${source}`);
      }
      sections.set(namespace, { version: raw.version as number, value: raw.value });
    }
  } else {
    for (const [namespace, raw] of Object.entries(value)) {
      if (registry.find(namespace) === undefined) {
        throw new Error(`Unknown configuration namespace ${namespace} in ${source}`);
      }
      sections.set(namespace, { version: 0, value: raw });
    }
  }
  return { sections, source, layer };
}

function migrate(
  section: ConfigurationSection<unknown, unknown>,
  raw: RawSection,
  source: string,
): unknown {
  if (raw.version > section.version) {
    throw new Error(
      `Unsupported version ${raw.version} for configuration section ${section.key.namespace} in ${source}`,
    );
  }
  let value = clone(raw.value);
  for (let version = raw.version; version < section.version; version += 1) {
    const migration = section.migrations[version];
    if (migration === undefined) {
      throw new Error(
        `Missing migration ${version} -> ${version + 1} for configuration section ${section.key.namespace} in ${source}`,
      );
    }
    value = migration(value);
  }
  return value;
}

class Snapshot implements ConfigurationSnapshot {
  readonly sources: readonly string[];
  readonly #values: Map<string, unknown>;
  readonly #projectOverrides: Map<string, Set<string>>;

  constructor(
    sources: readonly string[],
    values: Map<string, unknown>,
    projectOverrides: Map<string, Set<string>>,
  ) {
    this.sources = sources;
    this.#values = values;
    this.#projectOverrides = projectOverrides;
  }

  get<T>(key: ConfigurationKey<T>): T {
    if (!this.#values.has(key.namespace)) {
      throw new Error(`Unknown configuration namespace: ${key.namespace}`);
    }
    return this.#values.get(key.namespace) as T;
  }

  isProjectOverride<T>(key: ConfigurationKey<T>, path: string): boolean {
    return this.#projectOverrides.get(key.namespace)?.has(path) ?? false;
  }
}

export class FileConfigurationService {
  readonly #registry: ConfigurationRegistry;
  readonly #userPath: string;

  constructor(registry: ConfigurationRegistry, userPath: string) {
    this.#registry = registry;
    this.#userPath = userPath;
  }

  async load(projectPath: string): Promise<ConfigurationSnapshot> {
    const layers: RawLayer[] = [];
    for (const [path, layer] of [
      [this.#userPath, "user"],
      [projectPath, "project"],
    ] as const) {
      const value = await readJson(path);
      if (value !== undefined) layers.push(parseEnvelope(value, path, layer, this.#registry));
    }
    return this.#compose(layers);
  }

  async updateUser<T>(key: ConfigurationKey<T>, update: unknown): Promise<void> {
    const current = await readJson(this.#userPath);
    const layers =
      current === undefined ? [] : [parseEnvelope(current, this.#userPath, "user", this.#registry)];
    const snapshot = this.#compose(layers);
    const section = this.#registry.get(key);
    const context: ConfigurationContext = { source: this.#userPath, layer: "user" };
    const mergedRaw = deepMerge(section.serialize(snapshot.get(key)), update);
    const nextValue = section.merge(section.defaults, section.parse(mergedRaw, context), context);

    const sections: Record<string, RawSection> = {};
    for (const registered of this.#registry.sections()) {
      const value =
        registered.key.namespace === key.namespace ? nextValue : snapshot.get(registered.key);
      sections[registered.key.namespace] = {
        version: registered.version,
        value: registered.serialize(value),
      };
    }
    await mkdir(dirname(this.#userPath), { recursive: true });
    await writeFileAtomically(
      this.#userPath,
      `${JSON.stringify({ schemaVersion: ROOT_SCHEMA_VERSION, sections }, null, 2)}\n`,
    );
  }

  #compose(layers: readonly RawLayer[]): ConfigurationSnapshot {
    const values = new Map<string, unknown>();
    const overrides = new Map<string, Set<string>>();
    for (const section of this.#registry.sections())
      values.set(section.key.namespace, clone(section.defaults));

    for (const layer of layers) {
      for (const [namespace, raw] of layer.sections) {
        const section = this.#registry.find(namespace);
        if (section === undefined) continue;
        let value = migrate(section, raw, layer.source);
        for (const path of section.secretPaths) {
          if (hasPath(value, path)) {
            throw new Error(
              `Secret setting ${namespace}.${path} is not allowed in ${layer.source}`,
            );
          }
        }
        if (layer.layer === "project") {
          for (const path of section.sensitivePaths) deletePath(value, path);
        }
        const context: ConfigurationContext = { source: layer.source, layer: layer.layer };
        values.set(
          namespace,
          section.merge(values.get(namespace), section.parse(value, context), context),
        );
        if (layer.layer === "project" && isRecord(value)) {
          overrides.set(namespace, new Set(Object.keys(value)));
        }
      }
    }
    return new Snapshot(
      layers.map((layer) => layer.source),
      values,
      overrides,
    );
  }
}

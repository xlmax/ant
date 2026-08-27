import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationRegistry } from "../packages/app/src/configuration-registry.js";
import {
  configurationKey,
  type ConfigurationSection,
} from "../packages/app/src/configuration-section.js";
import { FileConfigurationService } from "../packages/cli/src/config/configuration-service.js";

interface ExampleSettings {
  label: string;
  endpoint: string;
  count: number;
}

type ExamplePartial = Partial<ExampleSettings>;
const EXAMPLE = configurationKey<ExampleSettings>("example");

function parseExample(value: unknown): ExamplePartial {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("example settings must be an object");
  }
  const source = value as Record<string, unknown>;
  const result: ExamplePartial = {};
  if (source.label !== undefined) {
    if (typeof source.label !== "string") throw new Error("example.label must be a string");
    result.label = source.label;
  }
  if (source.endpoint !== undefined) {
    if (typeof source.endpoint !== "string") throw new Error("example.endpoint must be a string");
    result.endpoint = source.endpoint;
  }
  if (source.count !== undefined) {
    if (!Number.isInteger(source.count)) throw new Error("example.count must be an integer");
    result.count = source.count as number;
  }
  return result;
}

const exampleSection: ConfigurationSection<ExampleSettings, ExamplePartial> = {
  key: EXAMPLE,
  version: 2,
  defaults: { label: "default", endpoint: "https://safe.example", count: 1 },
  migrations: {
    0: (value) => value,
    1: (value) => {
      const source = value as Record<string, unknown>;
      return { ...source, label: source.name ?? source.label };
    },
  },
  sensitivePaths: ["endpoint"],
  secretPaths: ["token"],
  parse: parseExample,
  merge: (current, partial) => ({ ...current, ...partial }),
  serialize: (value) => value,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ant-config-"));
  const userPath = join(root, "home", ".ant", "settings.json");
  const projectPath = join(root, "workspace", ".ant", "settings.json");
  const registry = new ConfigurationRegistry();
  registry.register(exampleSection);
  return {
    root,
    userPath,
    projectPath,
    registry,
    service: new FileConfigurationService(registry, userPath),
  };
}

async function put(path: string, value: unknown): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

test("configuration registry accepts an independent section and rejects duplicate namespaces", () => {
  const registry = new ConfigurationRegistry();
  registry.register(exampleSection);
  assert.throws(() => registry.register(exampleSection), /duplicate.*example/iu);
});

test("configuration service applies defaults, migrations and user/project precedence", async () => {
  const item = await fixture();
  try {
    await put(item.userPath, { example: { name: "legacy", count: 2 } });
    await put(item.projectPath, {
      schemaVersion: 1,
      sections: { example: { version: 2, value: { count: 3, endpoint: "https://evil" } } },
    });

    const loaded = await item.service.load(item.projectPath);
    assert.deepEqual(loaded.get(EXAMPLE), {
      label: "legacy",
      endpoint: "https://safe.example",
      count: 3,
    });
    assert.equal(loaded.isProjectOverride(EXAMPLE, "count"), true);
    assert.equal(loaded.isProjectOverride(EXAMPLE, "endpoint"), false);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("configuration service reports unknown namespaces, future versions and missing migrations", async () => {
  const item = await fixture();
  try {
    await put(item.userPath, { unknown: {} });
    await assert.rejects(
      () => item.service.load(item.projectPath),
      /unknown.*namespace.*unknown/iu,
    );

    await put(item.userPath, { schemaVersion: 2, sections: {} });
    await assert.rejects(() => item.service.load(item.projectPath), /schema version.*2/iu);

    await put(item.userPath, {
      schemaVersion: 1,
      sections: { example: { version: 3, value: {} } },
    });
    await assert.rejects(() => item.service.load(item.projectPath), /version 3.*example/iu);

    const noMigration = { ...exampleSection, version: 3, migrations: {} };
    const registry = new ConfigurationRegistry();
    registry.register(noMigration);
    const service = new FileConfigurationService(registry, item.userPath);
    await put(item.userPath, { example: {} });
    await assert.rejects(() => service.load(item.projectPath), /missing migration.*example/iu);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("configuration service rejects persisted secrets", async () => {
  const item = await fixture();
  try {
    await put(item.userPath, { example: { token: "secret" } });
    await assert.rejects(() => item.service.load(item.projectPath), /secret.*example\.token/iu);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("saving migrates a legacy user file atomically to the canonical envelope", async () => {
  const item = await fixture();
  try {
    await put(item.userPath, { example: { name: "legacy", count: 2 } });
    await item.service.updateUser(EXAMPLE, { count: 4 });
    const saved = JSON.parse(await readFile(item.userPath, "utf8")) as Record<string, unknown>;
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.sections, {
      example: {
        version: 2,
        value: { label: "legacy", endpoint: "https://safe.example", count: 4 },
      },
    });
    assert.equal((await item.service.load(item.projectPath)).get(EXAMPLE).count, 4);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("invalid updates do not replace the existing settings file", async () => {
  const item = await fixture();
  try {
    await put(item.userPath, { example: { count: 2 } });
    const before = await readFile(item.userPath, "utf8");
    await assert.rejects(() => item.service.updateUser(EXAMPLE, { count: "bad" }), /count/iu);
    assert.equal(await readFile(item.userPath, "utf8"), before);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

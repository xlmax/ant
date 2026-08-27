import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolPack } from "@ant/app";

import { parsePluginManifest } from "../packages/cli/src/plugins/manifest.js";
import { handlePluginCommand } from "../packages/cli/src/plugins/plugin-cli.js";
import { PluginInstaller } from "../packages/cli/src/plugins/plugin-installer.js";
import {
  loadInstalledPlugins,
  selectCompatibleToolPacks,
} from "../packages/cli/src/plugins/plugin-loader.js";
import { FilePluginRegistry } from "../packages/cli/src/plugins/plugin-registry.js";

const validManifest = {
  schemaVersion: 1,
  id: "example.tools",
  version: "1.2.3",
  apiVersion: ">=1.0.0 <2.0.0",
  entry: "./index.mjs",
  permissions: ["filesystem.read"],
};

test("plugin manifest validates compatibility, permissions and safe entrypoints", () => {
  assert.equal(parsePluginManifest(validManifest).id, "example.tools");
  assert.throws(
    () => parsePluginManifest({ ...validManifest, apiVersion: ">=2.0.0 <3.0.0" }),
    /incompatible/iu,
  );
  assert.throws(
    () => parsePluginManifest({ ...validManifest, permissions: ["host.root"] }),
    /permission/iu,
  );
  assert.throws(
    () => parsePluginManifest({ ...validManifest, entry: "../outside.mjs" }),
    /entry/iu,
  );
  assert.throws(() => parsePluginManifest({ ...validManifest, id: "../escape" }), /id/iu);
});

test("loader isolates broken plugins and activates compatible enabled plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-plugin-loader-"));
  const logs: string[] = [];
  try {
    const registry = new FilePluginRegistry(root);
    for (const [id, source] of [
      [
        "example.tools",
        `export default { activate() { return { toolPacks: [{ id: "example.tools", create() { return []; } }] }; } };`,
      ],
      ["broken.tools", `throw new Error("secret token: do-not-leak");`],
    ] as const) {
      const directory = join(root, "packages", id);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "ant-plugin.json"),
        JSON.stringify({ ...validManifest, id, permissions: [] }),
      );
      await writeFile(join(directory, "index.mjs"), source);
      await registry.upsert({
        id,
        version: "1.2.3",
        source: directory,
        approvedPermissions: [],
        enabled: true,
      });
    }

    const result = await loadInstalledPlugins({
      root,
      workspace: root,
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    });
    assert.deepEqual(
      result.toolPacks.map(({ id }) => id),
      ["example.tools"],
    );
    assert.equal(result.diagnostics.find(({ id }) => id === "example.tools")?.state, "active");
    assert.equal(result.diagnostics.find(({ id }) => id === "broken.tools")?.state, "failed");
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /do-not-leak/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader rejects symlink escapes and permission escalation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-plugin-security-"));
  try {
    const registry = new FilePluginRegistry(root);
    const outside = join(root, "outside.mjs");
    await writeFile(outside, "export default { activate() { return {}; } };\n");
    const escaped = join(root, "packages", "escaped.tools");
    await mkdir(escaped, { recursive: true });
    await writeFile(
      join(escaped, "ant-plugin.json"),
      JSON.stringify({ ...validManifest, id: "escaped.tools", permissions: [] }),
    );
    await symlink(outside, join(escaped, "index.mjs"));
    await registry.upsert({
      id: "escaped.tools",
      version: "1.2.3",
      source: escaped,
      approvedPermissions: [],
      enabled: true,
    });

    const escalating = join(root, "packages", "escalating.tools");
    await mkdir(escalating, { recursive: true });
    await writeFile(
      join(escalating, "ant-plugin.json"),
      JSON.stringify({ ...validManifest, id: "escalating.tools", permissions: [] }),
    );
    await writeFile(
      join(escalating, "index.mjs"),
      `export default { activate() { return { toolPacks: [{
        id: "escalating.tools",
        create() { return [{
          metadata: { ownerId: "escalating.tools", sideEffects: "none", parallelSafe: true, requiredCapabilities: ["filesystem.write"] },
          spec: { name: "escalate", description: "bad", inputSchema: {} },
          async execute() {}
        }]; }
      }] }; } };\n`,
    );
    await registry.upsert({
      id: "escalating.tools",
      version: "1.2.3",
      source: escalating,
      approvedPermissions: [],
      enabled: true,
    });

    const loaded = await loadInstalledPlugins({
      root,
      workspace: root,
      logger: { info() {}, warn() {} },
    });
    assert.equal(loaded.diagnostics.find(({ id }) => id === "escaped.tools")?.state, "failed");
    const escalatingPack = loaded.toolPacks.find(({ id }) => id === "escalating.tools");
    assert.ok(escalatingPack);
    assert.throws(
      () =>
        escalatingPack.create({
          workspace: root,
          capabilities: new Set(["filesystem.write"]),
          process: {},
          logger: { debug() {} },
        }),
      /permission escalation/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external tool pack conflicts are isolated before a user turn", () => {
  const pack = (id: string, name: string): ToolPack => ({
    id,
    create: () => [
      {
        metadata: {
          ownerId: id,
          sideEffects: "none",
          parallelSafe: true,
          requiredCapabilities: [],
        },
        spec: { name, description: name, inputSchema: {} },
        async execute() {},
      },
    ],
  });
  const rejected: string[] = [];
  const accepted = selectCompatibleToolPacks(
    pack("built-in", "read"),
    [pack("safe.plugin", "external_read"), pack("conflicting.plugin", "read")],
    {
      workspace: ".",
      capabilities: new Set(),
      process: {},
      logger: { debug() {} },
    },
    ({ id }) => rejected.push(id),
  );
  assert.deepEqual(
    accepted.map(({ id }) => id),
    ["safe.plugin"],
  );
  assert.deepEqual(rejected, ["conflicting.plugin"]);
});

test("installer skips lifecycle scripts, updates atomically and removes recoverably", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-plugin-installer-"));
  const source = join(root, "source");
  const pluginRoot = join(root, "plugins");
  const marker = join(root, "install-script-ran");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "example-plugin-package",
        version: "1.2.3",
        scripts: {
          prepack: `node -e "require('fs').writeFileSync('${marker}', 'bad')"`,
          install: `node -e "require('fs').writeFileSync('${marker}', 'bad')"`,
        },
      }),
    );
    await writeFile(join(source, "ant-plugin.json"), JSON.stringify(validManifest));
    await writeFile(join(source, "index.mjs"), "export default { activate() { return {}; } };\n");

    const installer = new PluginInstaller(pluginRoot);
    await assert.rejects(() => installer.install(source, []), /approval/iu);
    const installed = await installer.install(source, ["filesystem.read"]);
    assert.equal(installed.id, "example.tools");
    await assert.rejects(() => readFile(marker), /ENOENT/u);

    const output: string[] = [];
    const commandOutput = {
      log: (message: string) => output.push(message),
      error: (message: string) => output.push(message),
    };
    assert.equal(
      await handlePluginCommand(["plugins", "list"], { root: pluginRoot, output: commandOutput }),
      true,
    );
    assert.match(output.join("\n"), /example\.tools 1\.2\.3 enabled/u);
    await handlePluginCommand(["plugins", "disable", "example.tools"], {
      root: pluginRoot,
      output: commandOutput,
    });
    assert.equal((await new FilePluginRegistry(pluginRoot).get("example.tools"))?.enabled, false);
    await handlePluginCommand(["plugins", "enable", "example.tools"], {
      root: pluginRoot,
      output: commandOutput,
    });
    await handlePluginCommand(["plugins", "inspect", "example.tools"], {
      root: pluginRoot,
      output: commandOutput,
    });
    assert.match(output.join("\n"), /"apiVersion": ">=1\.0\.0 <2\.0\.0"/u);

    await writeFile(join(source, "ant-plugin.json"), "{}");
    await assert.rejects(
      () => installer.install(source, ["filesystem.read"]),
      /manifest|schemaVersion/iu,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(pluginRoot, "packages", "example.tools", "ant-plugin.json"), "utf8"),
      ).version,
      "1.2.3",
    );

    await handlePluginCommand(["plugins", "remove", "example.tools"], {
      root: pluginRoot,
      output: commandOutput,
    });
    assert.match(output.at(-1) ?? "", /recoverable copy: .*\.trash/u);
    assert.equal(await new FilePluginRegistry(pluginRoot).get("example.tools"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

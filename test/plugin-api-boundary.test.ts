import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateExternalToolPack } from "../packages/cli/src/plugin-api.js";

test("published plugin API is independent from internal workspace packages", async () => {
  const [source, manifest] = await Promise.all([
    readFile(new URL("../packages/cli/src/plugin-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(source, /@ant\//u);
  assert.doesNotMatch(source, /\.\.\/(?:app|core|frontend|tools)/u);
  assert.equal(JSON.parse(manifest).exports["./plugin-api"].default, "./dist/plugin-api.js");
});

test("published plugin API provides a reusable external tool contract check", () => {
  const pack = {
    id: "example.tools",
    create: () => [
      {
        metadata: {
          ownerId: "example.tools",
          sideEffects: "none" as const,
          parallelSafe: true,
          requiredCapabilities: [] as const,
        },
        spec: { name: "example", description: "Example", inputSchema: {} },
        async execute() {},
      },
    ],
  };
  assert.equal(
    validateExternalToolPack("example.tools", pack, {
      workspace: ".",
      capabilities: new Set(),
      logger: { info() {}, warn() {} },
    }).length,
    1,
  );
  assert.throws(
    () =>
      validateExternalToolPack("another.plugin", pack, {
        workspace: ".",
        capabilities: new Set(),
        logger: { info() {}, warn() {} },
      }),
    /owned/iu,
  );
});

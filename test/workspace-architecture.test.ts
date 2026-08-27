import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeWorkspaces } from "./support/workspace-analyzer.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("workspace packages expose only the declared dependency graph", async () => {
  assert.deepEqual(await analyzeWorkspaces(projectRoot), []);
});

test("workspace analysis detects an adapter dependency and internal import", async () => {
  const root = join(tmpdir(), `ant-workspace-fixture-${process.pid}-${Date.now()}`);
  const names = [
    "contracts",
    "core",
    "app",
    "provider-deepseek",
    "session-jsonl",
    "tools-coding",
    "frontend-terminal",
    "cli",
  ];
  for (const name of names) {
    const sourceRoot = join(root, "packages", name, "src");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ name: `@ant/${name}`, exports: "./dist/index.js" }),
    );
    await writeFile(join(sourceRoot, "index.ts"), "export {};\n");
  }
  await writeFile(
    join(root, "packages", "provider-deepseek", "package.json"),
    JSON.stringify({
      name: "@ant/provider-deepseek",
      exports: "./dist/index.js",
      dependencies: { "@ant/session-jsonl": "0.5.15" },
    }),
  );
  await writeFile(
    join(root, "packages", "tools-coding", "src", "index.ts"),
    'export * from "@ant/app/src/tools.js";\n',
  );

  const violations = await analyzeWorkspaces(root);
  assert.ok(violations.some(({ kind }) => kind === "dependency"));
  assert.ok(violations.some(({ kind }) => kind === "internal-import"));
});

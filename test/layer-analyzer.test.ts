import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { analyzeLayerBoundaries } from "./support/layer-analyzer.js";

async function withSourceTree(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ant-layers-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("layer analyzer accepts inward imports and rejects static, dynamic, and type-only outward imports", async () => {
  await withSourceTree(
    {
      "core/domain.ts": "export interface Domain { value: string }",
      "config/settings.ts": "export interface Settings { value: string }",
      "config/runtime.ts": "export const runtime = true;",
      "app/use-case.ts": `
        import type { Domain } from "../core/domain.js";
        type LeakedSettings = import("../config/settings.js").Settings;
        const adapter = import("../config/runtime.js");
        // import "../ui/comment.js";
        const example = 'import("../models/string.js")';
        export type Result = Domain & LeakedSettings;
        export { adapter };
      `,
    },
    async (root) => {
      const violations = await analyzeLayerBoundaries(root);
      assert.deepEqual(
        violations.map((violation) => violation.kind),
        ["dependency", "dependency"],
      );
      assert.ok(violations.every((violation) => violation.message.startsWith("app/use-case.ts")));
    },
  );
});

test("layer analyzer rejects opaque imports, unknown layers, and external core modules", async () => {
  await withSourceTree(
    {
      "core/domain.ts": `
        import "node:fs";
        export const lazy = import(moduleName);
      `,
      "mystery/adapter.ts": "export const adapter = true;",
    },
    async (root) => {
      const violations = await analyzeLayerBoundaries(root);
      assert.deepEqual(
        new Set(violations.map((violation) => violation.kind)),
        new Set(["unknown-module", "dependency", "opaque-import"]),
      );
    },
  );
});

test("layer analyzer treats named type imports and exports as runtime cycle edges", async () => {
  await withSourceTree(
    {
      "app/named-a.ts": `
        import { type NamedB } from "./named-b.js";
        export interface NamedA { b?: NamedB }
      `,
      "app/named-b.ts": `
        export { type NamedA } from "./named-a.js";
        export interface NamedB { value: string }
      `,
    },
    async (root) => {
      const violations = await analyzeLayerBoundaries(root);
      assert.equal(violations.filter((violation) => violation.kind === "cycle").length, 1);
      assert.match(
        violations.find((violation) => violation.kind === "cycle")?.message ?? "",
        /app\/named-a\.ts.*app\/named-b\.ts.*app\/named-a\.ts/u,
      );
    },
  );
});

test("layer analyzer detects runtime cycles but ignores declaration-level type cycles", async () => {
  await withSourceTree(
    {
      "app/a.ts": 'import { b } from "./b.js"; export const a = b;',
      "app/b.ts": 'import { a } from "./a.js"; export const b = a;',
      "core/type-a.ts": 'import type { B } from "./type-b.js"; export interface A extends B {}',
      "core/type-b.ts": 'import type { A } from "./type-a.js"; export interface B { a?: A }',
    },
    async (root) => {
      const violations = await analyzeLayerBoundaries(root);
      assert.equal(violations.filter((violation) => violation.kind === "cycle").length, 1);
      assert.match(
        violations.find((violation) => violation.kind === "cycle")?.message ?? "",
        /app\/a\.ts.*app\/b\.ts.*app\/a\.ts/u,
      );
    },
  );
});

test("layer analyzer keeps presentation away from low-level application infrastructure", async () => {
  await withSourceTree(
    {
      "core/runtime.ts": "export interface Runtime {}",
      "app/model-provider.ts": "export interface Provider {}",
      "app/session-controller.ts": "export class SessionController {}",
      "ui/frontend.ts": `
        import type { Runtime } from "../core/runtime.js";
        import type { Provider } from "../app/model-provider.js";
        import { SessionController } from "../app/session-controller.js";
        export type Leaks = Runtime & Provider;
        export { SessionController };
      `,
    },
    async (root) => {
      const violations = await analyzeLayerBoundaries(root);
      assert.equal(violations.filter((violation) => violation.kind === "dependency").length, 3);
      assert.ok(violations.every((violation) => violation.message.startsWith("ui/frontend.ts")));
    },
  );
});

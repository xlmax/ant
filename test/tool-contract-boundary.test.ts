import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

test("application owns the public tool and registry contracts", async () => {
  const applicationContract = await readFile(source("packages/app/src/tools.ts"), "utf8");
  const environmentAdapter = await readFile(
    source("packages/tools-coding/src/tool-environment.ts"),
    "utf8",
  );

  assert.match(applicationContract, /interface ToolPack/u);
  assert.match(applicationContract, /interface ToolMetadata/u);
  assert.doesNotMatch(applicationContract, /\.\.\/tools\//u);
  assert.match(environmentAdapter, /from "@ant\/app"/u);
  assert.doesNotMatch(environmentAdapter, /export interface Tool\b/u);
});

test("composition root registers tool packs instead of enumerating tools", async () => {
  const main = await readFile(source("packages/cli/src/main.ts"), "utf8");

  assert.match(main, /register\(codingToolPack\)/u);
  assert.doesNotMatch(main, /createCodingTools/u);
  assert.doesNotMatch(main, /create(Read|Glob|Grep|Bash|Edit|Write)Tool/u);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolEnvironment } from "../packages/tools-coding/src/tool-environment.js";
import { createGlobTool } from "../packages/tools-coding/src/glob-tool.js";
import { createGrepTool } from "../packages/tools-coding/src/grep-tool.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ant-search-"));
}

test("grep finds matching lines with paths and line numbers", async () => {
  const workspace = await createWorkspace();

  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "a.ts"),
      "export const one = 1;\nconst two = 2;\n",
      "utf8",
    );
    await writeFile(join(workspace, "src", "b.ts"), "export const three = 3;\n", "utf8");
    const environment = new ToolEnvironment([createGrepTool(workspace)]);

    const observation = await environment.execute({
      id: "grep-1",
      name: "grep",
      input: { pattern: "export const" },
    });

    assert.deepEqual(observation, {
      ok: true,
      value: {
        matches: [
          { path: "src/a.ts", line: 1, text: "export const one = 1;" },
          { path: "src/b.ts", line: 1, text: "export const three = 3;" },
        ],
        truncated: false,
        filesSearched: 2,
        skippedFiles: 0,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("grep honors include and ignoreCase and caps results", async () => {
  const workspace = await createWorkspace();

  try {
    await writeFile(join(workspace, "a.txt"), "Alpha\nBETA\nalpha\n", "utf8");
    await writeFile(join(workspace, "b.md"), "Alpha\n", "utf8");
    const environment = new ToolEnvironment([createGrepTool(workspace)]);

    const observation = await environment.execute({
      id: "grep-2",
      name: "grep",
      input: { pattern: "alpha", ignoreCase: true, include: "*.txt", maxResults: 1 },
    });

    assert.deepEqual(observation, {
      ok: true,
      value: {
        matches: [{ path: "a.txt", line: 1, text: "Alpha" }],
        truncated: true,
        filesSearched: 1,
        skippedFiles: 0,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("grep reports an invalid regular expression as an error", async () => {
  const workspace = await createWorkspace();

  try {
    const environment = new ToolEnvironment([createGrepTool(workspace)]);
    const observation = await environment.execute({
      id: "grep-3",
      name: "grep",
      input: { pattern: "(" },
    });

    assert.equal(observation.ok, false);
    assert.ok(typeof observation.error === "string");
    assert.match(observation.error, /invalid regular expression/iu);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("grep bounds catastrophic regex backtracking", async () => {
  const workspace = await createWorkspace();

  try {
    await writeFile(join(workspace, "adversarial.txt"), `${"a".repeat(200)}!\n`, "utf8");
    const environment = new ToolEnvironment([createGrepTool(workspace)]);

    const observation = await environment.execute({
      id: "grep-4",
      name: "grep",
      input: { pattern: "(a+)+$" },
    });

    assert.equal(observation.ok, true);
    assert.ok(typeof observation.value === "object" && observation.value !== null);
    const value = observation.value as Record<string, unknown>;
    assert.equal(value.regexTimedOut, true);
    assert.equal(value.truncated, true);
    assert.equal(value.regexTimeoutPath, "adversarial.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob finds files matching a pattern", async () => {
  const workspace = await createWorkspace();

  try {
    await mkdir(join(workspace, "src", "nested"), { recursive: true });
    await writeFile(join(workspace, "src", "a.ts"), "", "utf8");
    await writeFile(join(workspace, "src", "nested", "b.ts"), "", "utf8");
    await writeFile(join(workspace, "src", "nested", "c.md"), "", "utf8");
    const environment = new ToolEnvironment([createGlobTool(workspace)]);

    const observation = await environment.execute({
      id: "glob-1",
      name: "glob",
      input: { pattern: "src/**/*.ts" },
    });

    assert.deepEqual(observation, {
      ok: true,
      value: { matches: ["src/a.ts", "src/nested/b.ts"], truncated: false },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolEnvironment } from "../src/core/environment.js";
import { createEditTool } from "../src/tools/edit-tool.js";
import { createWriteTool } from "../src/tools/write-tool.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "minimal-agent-"));
}

test("write creates parent directories and edit applies replacements atomically", async () => {
  const workspace = await createWorkspace();

  try {
    const environment = new ToolEnvironment([
      createWriteTool(workspace),
      createEditTool(workspace),
    ]);
    const path = "nested/example.txt";

    const writeResult = await environment.execute({
      id: "write-call",
      name: "write",
      input: { path, content: "first\nsecond\n" },
    });
    const editResult = await environment.execute({
      id: "edit-call",
      name: "edit",
      input: {
        path,
        edits: [
          { oldText: "first", newText: "one" },
          { oldText: "second", newText: "two" },
        ],
      },
    });

    assert.deepEqual(writeResult, {
      ok: true,
      value: { path, bytesWritten: 13 },
    });
    assert.deepEqual(editResult, {
      ok: true,
      value: { path, editsApplied: 2, bytesWritten: 8 },
    });
    assert.equal(await readFile(join(workspace, path), "utf8"), "one\ntwo\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("edit does not write a partial result when a replacement is invalid", async () => {
  const workspace = await createWorkspace();

  try {
    const path = join(workspace, "example.txt");
    await writeFile(path, "first\nsecond\n", "utf8");
    const environment = new ToolEnvironment([createEditTool(workspace)]);

    const observation = await environment.execute({
      id: "edit-invalid-call",
      name: "edit",
      input: {
        path: "example.txt",
        edits: [
          { oldText: "first", newText: "one" },
          { oldText: "missing", newText: "three" },
        ],
      },
    });

    assert.equal(observation.ok, false);
    assert.equal(await readFile(path, "utf8"), "first\nsecond\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

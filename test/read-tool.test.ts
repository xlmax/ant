import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolEnvironment } from "../src/core/environment.js";
import { createReadTool } from "../src/tools/read-tool.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "minimal-agent-"));
}

test("read supports line ranges and absolute paths", async () => {
  const workspace = await createWorkspace();

  try {
    const file = join(workspace, ".env.local");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const environment = new ToolEnvironment([createReadTool(workspace)]);

    const observation = await environment.execute({
      id: "read-call",
      name: "read",
      input: { path: file, offset: 2, limit: 1 },
    });

    assert.deepEqual(observation, {
      ok: true,
      value: {
        path: file,
        content: "two",
        totalLines: 4,
        startLine: 2,
        endLine: 2,
        truncated: true,
        nextOffset: 3,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

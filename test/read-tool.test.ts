import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolEnvironment } from "../src/core/environment.js";
import { createReadTool } from "../src/tools/read-tool.js";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ant-"));
}

test("read returns supported images as multimodal attachments", async () => {
  const workspace = await createWorkspace();

  try {
    const file = join(workspace, "screen.png");
    const content = Buffer.from("89504e470d0a1a0a00000000", "hex");
    await writeFile(file, content);
    const environment = new ToolEnvironment([createReadTool(workspace)]);

    const observation = await environment.execute({
      id: "read-image",
      name: "read",
      input: { path: file },
    });

    const cachedPath = join(
      workspace,
      ".ant",
      "attachments",
      `${createHash("sha256").update(content).digest("hex")}.png`,
    );
    assert.deepEqual(await readFile(cachedPath), content);
    assert.deepEqual(observation, {
      ok: true,
      value: {
        path: file,
        kind: "image",
        mediaType: "image/png",
        bytes: content.length,
      },
      attachments: [{
        type: "image",
        path: cachedPath,
        mediaType: "image/png",
        bytes: content.length,
      }],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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

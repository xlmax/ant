import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSystemPrompt } from "../packages/cli/src/config/system-prompt.js";

test("system prompt loads the bundled default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ant-prompt-"));

  try {
    const prompt = await loadSystemPrompt(workspace);

    assert.match(prompt.content, /компонент принятия решений coding-агента/u);
    assert.ok(
      prompt.sources.some((path) => path.replaceAll("\\", "/").endsWith("prompts/SYSTEM.md")),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("configured and project system prompts are appended after the bundled default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ant-prompt-"));

  try {
    const directory = join(workspace, ".ant");
    await mkdir(directory);
    await writeFile(join(directory, "SYSTEM.md"), "Проектное правило.", "utf8");
    await writeFile(join(workspace, "extra.md"), "Дополнительное правило.", "utf8");

    const prompt = await loadSystemPrompt(workspace, ["extra.md"]);

    assert.match(prompt.content, /Дополнительное правило\.$/u);
    assert.ok(prompt.sources.includes(join(directory, "SYSTEM.md")));
    assert.ok(prompt.sources.includes(join(workspace, "extra.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

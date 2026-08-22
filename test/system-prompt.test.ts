import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSystemPrompt } from "../src/config/system-prompt.js";

test("system prompt loads the bundled default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minimal-agent-prompt-"));

  try {
    const prompt = await loadSystemPrompt(workspace);

    assert.match(prompt.content, /компонент принятия решений coding-агента/u);
    assert.ok(
      prompt.sources.some((path) =>
        path.replaceAll("\\", "/").endsWith("prompts/SYSTEM.md"),
      ),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project system prompt is appended after the bundled default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "minimal-agent-prompt-"));

  try {
    const directory = join(workspace, ".agent");
    await mkdir(directory);
    await writeFile(join(directory, "SYSTEM.md"), "Проектное правило.", "utf8");

    const prompt = await loadSystemPrompt(workspace);

    assert.match(prompt.content, /Проектное правило\.$/u);
    assert.ok(prompt.sources.includes(join(directory, "SYSTEM.md")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

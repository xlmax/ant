import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSettings } from "../src/config/settings.js";

async function temporaryDirectories(): Promise<{ workspace: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "minimal-agent-settings-"));
  return {
    workspace: join(root, "workspace"),
    home: join(root, "home"),
  };
}

test("settings merge global, project and environment layers", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".minimal-ai-agent"), { recursive: true });
    await writeFile(
      join(home, ".minimal-ai-agent", "settings.json"),
      JSON.stringify({
        model: { id: "deepseek-v4-pro", thinking: { effort: "max" } },
      }),
      "utf8",
    );
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "settings.json"),
      JSON.stringify({
        model: { thinking: { enabled: false } },
        ui: { showReasoning: true },
      }),
      "utf8",
    );

    const loaded = await loadSettings(
      workspace,
      {
        DEEPSEEK_MODEL: "deepseek-v4-flash",
        DEEPSEEK_THINKING: "true",
        DEEPSEEK_REASONING_EFFORT: "low",
      },
      home,
    );

    assert.deepEqual(loaded.settings, {
      model: {
        provider: "deepseek",
        id: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 1_000_000,
        thinking: { enabled: true, effort: "low" },
      },
      ui: { showReasoning: true },
    });
    assert.equal(loaded.sources.length, 2);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("settings reject unsupported providers and invalid JSON", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(workspace, ".agent"), { recursive: true });
    await writeFile(
      join(workspace, ".agent", "settings.json"),
      '{"model":{"provider":"other"}}',
      "utf8",
    );

    await assert.rejects(
      loadSettings(workspace, {}, home),
      /Неподдерживаемый provider: other/u,
    );

    await writeFile(join(workspace, ".agent", "settings.json"), "{", "utf8");
    await assert.rejects(
      loadSettings(workspace, {}, home),
      /некорректный JSON/u,
    );
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

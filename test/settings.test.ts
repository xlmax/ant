import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSettings,
  saveUserModelId,
  saveUserModelThinking,
  saveUserShowReasoning,
} from "../src/config/settings.js";

async function temporaryDirectories(): Promise<{ workspace: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "ant-settings-"));
  return {
    workspace: join(root, "workspace"),
    home: join(root, "home"),
  };
}

test("settings merge global and project layers without environment overrides", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({
        model: { id: "deepseek-v4-pro", thinking: { effort: "max" } },
        ui: { color: false },
        prompts: { additionalPaths: ["prompts/extra.md"] },
        limits: { modelMaxAttempts: 2 },
      }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({
        model: { thinking: { enabled: false } },
        ui: { showReasoning: true },
        tools: { bashPath: "/custom/bash" },
        limits: { turnTimeoutSeconds: 120 },
      }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);

    assert.deepEqual(loaded.settings, {
      model: {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com",
        contextWindow: 1_000_000,
        vision: false,
        thinking: { enabled: false, effort: "max" },
      },
      ui: { showReasoning: true, color: false },
      prompts: { additionalPaths: ["prompts/extra.md"] },
      tools: { bashPath: "/custom/bash" },
      limits: {
        turnTimeoutSeconds: 120,
        modelRequestTimeoutSeconds: 90,
        modelMaxAttempts: 2,
      },
    });
    assert.equal(loaded.sources.length, 2);
    assert.deepEqual(loaded.projectOverrides, {
      modelId: false,
      modelThinking: true,
      showReasoning: true,
    });
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("project settings can clear an inherited bash path", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ tools: { bashPath: "/global/bash" } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ tools: { bashPath: null } }),
      "utf8",
    );

    assert.deepEqual((await loadSettings(workspace, home)).settings.tools, {});
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving a selected model updates the global user settings only", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    const settingsDirectory = join(home, ".ant");
    await mkdir(settingsDirectory, { recursive: true });
    await writeFile(
      join(settingsDirectory, "settings.json"),
      JSON.stringify({
        model: { baseUrl: "https://proxy.example" },
        ui: { showReasoning: true },
        future: { setting: true },
      }),
      "utf8",
    );

    await saveUserModelId("deepseek-v4-pro", home);

    assert.deepEqual(JSON.parse(await readFile(join(settingsDirectory, "settings.json"), "utf8")), {
      model: {
        baseUrl: "https://proxy.example",
        id: "deepseek-v4-pro",
        vision: false,
      },
      ui: { showReasoning: true },
      future: { setting: true },
    });
    assert.equal((await loadSettings(workspace, home)).settings.model.id, "deepseek-v4-pro");
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving thinking settings uses the global layer", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "deepseek-v4-pro" }, future: { setting: true } }),
      "utf8",
    );

    await saveUserModelThinking({ enabled: true, effort: "max" }, home);

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      model: {
        id: "deepseek-v4-pro",
        thinking: { enabled: true, effort: "max" },
      },
      future: { setting: true },
    });
    assert.deepEqual((await loadSettings(workspace, home)).settings.model.thinking, {
      enabled: true,
      effort: "max",
    });

    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { thinking: { effort: "low" } } }),
      "utf8",
    );

    assert.deepEqual((await loadSettings(workspace, home)).settings.model.thinking, {
      enabled: true,
      effort: "low",
    });
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving reasoning visibility uses the global layer", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await saveUserShowReasoning(true, home);

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      ui: { showReasoning: true },
    });
    assert.equal((await loadSettings(workspace, home)).settings.ui.showReasoning, true);

    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ ui: { showReasoning: false } }),
      "utf8",
    );

    assert.equal((await loadSettings(workspace, home)).settings.ui.showReasoning, false);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving reasoning visibility reports malformed global settings", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(join(home, ".ant", "settings.json"), "{", "utf8");

    await assert.rejects(saveUserShowReasoning(true, home), /некорректный JSON/u);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("settings reject unsupported providers and invalid JSON", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      '{"model":{"provider":"other"}}',
      "utf8",
    );

    await assert.rejects(loadSettings(workspace, home), /Неподдерживаемый provider: other/u);

    await writeFile(join(workspace, ".ant", "settings.json"), "{", "utf8");
    await assert.rejects(loadSettings(workspace, home), /некорректный JSON/u);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

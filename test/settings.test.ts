import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSettings,
  readExplicitVision,
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

test("stale user-layer vision is ignored before the first /model", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "deepseek-v4-flash", vision: false } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "custom-vision-exp" } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.model.id, "custom-vision-exp");
    assert.equal(loaded.settings.model.vision, true);
    assert.equal(await readExplicitVision(workspace, home), undefined);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("project vision overrides an opposite global value", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "global-text", vision: true } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "project-text", vision: false } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.model.id, "project-text");
    assert.equal(loaded.settings.model.vision, false);
    assert.equal(await readExplicitVision(workspace, home), false);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("readExplicitVision returns explicit vision with the project layer winning", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { vision: true } }),
      "utf8",
    );

    assert.equal(await readExplicitVision(workspace, home), true);

    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { vision: false } }),
      "utf8",
    );
    assert.equal(await readExplicitVision(workspace, home), false);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("readExplicitVision is undefined when no layer sets vision", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    assert.equal(await readExplicitVision(workspace, home), undefined);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saveUserModelId drops a stale auto-written vision so the heuristic re-applies", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "deepseek-v4-flash", vision: false } }),
      "utf8",
    );

    await saveUserModelId("custom-vision-exp", home);

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      model: { id: "custom-vision-exp" },
    });
    assert.equal(await readExplicitVision(workspace, home), undefined);
    assert.equal((await loadSettings(workspace, home)).settings.model.vision, true);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saveUserModelId preserves a genuinely explicit vision", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "custom-text", vision: true } }),
      "utf8",
    );

    await saveUserModelId("another-id", home);

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      model: { id: "another-id", vision: true },
    });
    assert.equal(await readExplicitVision(workspace, home), true);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("explicit vision from an earlier layer survives a later UI-only merge", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "custom-text", vision: true } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ ui: { showReasoning: true } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.model.id, "custom-text");
    assert.equal(loaded.settings.model.vision, true);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("heuristic vision is a fallback when no layer sets it explicitly", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { id: "custom-vision-exp" } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ ui: { color: false } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.model.vision, true);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

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
      ui: { showReasoning: true, showChanges: false, color: false },
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
      showChanges: false,
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
      },
      ui: { showReasoning: true },
      future: { setting: true },
    });
    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.model.id, "deepseek-v4-pro");
    // vision is not persisted explicitly: it is resolved by heuristic on load.
    assert.equal(loaded.settings.model.vision, false);
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

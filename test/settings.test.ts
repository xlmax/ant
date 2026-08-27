import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSettings,
  readExplicitVision,
  saveUserModelId,
  saveUserModelProviderOptions,
  saveUserReasoningMode,
} from "../src/config/settings.js";
import type { LoadedSettings } from "../src/app/configuration.js";
import { DeepSeekProvider } from "../src/models/deepseek-provider.js";

function modelOptions(loaded: LoadedSettings): Record<string, unknown> {
  return loaded.settings.model.providerOptions as Record<string, unknown>;
}

function modelThinking(loaded: LoadedSettings): unknown {
  return modelOptions(loaded).thinking;
}

function modelVision(loaded: LoadedSettings): boolean {
  return new DeepSeekProvider({ apiKey: "test", systemPrompt: "system" }).describe(
    loaded.settings.model,
  ).capabilities.vision;
}

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
    assert.equal(loaded.settings.model.modelId, "custom-vision-exp");
    assert.equal(modelVision(loaded), true);
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
    assert.equal(loaded.settings.model.modelId, "project-text");
    assert.equal(modelVision(loaded), false);
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
    assert.equal(modelVision(await loadSettings(workspace, home)), true);
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
    assert.equal(loaded.settings.model.modelId, "custom-text");
    assert.equal(modelVision(loaded), true);
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
    assert.equal(modelVision(loaded), true);
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
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        providerOptions: {
          baseUrl: "https://api.deepseek.com",
          contextWindow: 1_000_000,
          thinking: { enabled: false, effort: "max" },
        },
      },
      ui: {
        reasoningMode: "compact",
        reasoningMaxLines: 6,
        showChanges: false,
        color: false,
      },
      prompts: { additionalPaths: ["prompts/extra.md"] },
      tools: { bashPath: "/custom/bash" },
      limits: {
        turnTimeoutSeconds: 120,
        modelRequestTimeoutSeconds: 90,
        modelMaxAttempts: 2,
      },
      verification: {
        enabled: true,
        maxRounds: 2,
        checks: ["empty-answer", "echo-task", "failed-tools"],
      },
    });
    assert.equal(loaded.sources.length, 2);
    assert.deepEqual(loaded.projectOverrides, {
      modelId: false,
      modelThinking: true,
      reasoningMode: true,
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

test("project settings cannot override model.baseUrl", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { baseUrl: "https://proxy.example" } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { baseUrl: "https://evil.example" } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(modelOptions(loaded).baseUrl, "https://proxy.example");
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("project settings cannot set model.baseUrl without a user value", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { baseUrl: "https://evil.example" } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(modelOptions(loaded).baseUrl, "https://api.deepseek.com");
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("project opaque options cannot redirect the model endpoint", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ model: { options: { baseUrl: "https://proxy.example" } } }),
      "utf8",
    );
    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({
        model: {
          options: {
            baseUrl: "https://evil.example",
            thinking: { enabled: false, effort: "low" },
          },
        },
      }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(modelOptions(loaded).baseUrl, "https://proxy.example");
    assert.equal((modelOptions(loaded).thinking as { enabled: boolean }).enabled, false);
    assert.equal(loaded.projectOverrides.modelThinking, true);
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
    assert.equal(loaded.settings.model.modelId, "deepseek-v4-pro");
    // vision is not persisted explicitly: it is resolved by heuristic on load.
    assert.equal(modelVision(loaded), false);
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

    await saveUserModelProviderOptions(
      "deepseek",
      { thinking: { enabled: true, effort: "max" } },
      home,
    );

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      model: {
        id: "deepseek-v4-pro",
        options: { thinking: { enabled: true, effort: "max" } },
      },
      future: { setting: true },
    });
    assert.deepEqual(modelThinking(await loadSettings(workspace, home)), {
      enabled: true,
      effort: "max",
    });

    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ model: { thinking: { effort: "low" } } }),
      "utf8",
    );

    assert.deepEqual(modelThinking(await loadSettings(workspace, home)), {
      enabled: true,
      effort: "low",
    });
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("reasoning display settings load compact mode and viewport height", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({ ui: { reasoningMode: "compact", reasoningMaxLines: 8 } }),
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.equal(loaded.settings.ui.reasoningMode, "compact");
    assert.equal(loaded.settings.ui.reasoningMaxLines, 8);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving reasoning mode uses the global layer and legacy visibility still loads", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await saveUserReasoningMode("full", home);

    assert.deepEqual(JSON.parse(await readFile(join(home, ".ant", "settings.json"), "utf8")), {
      ui: { reasoningMode: "full" },
    });
    assert.equal((await loadSettings(workspace, home)).settings.ui.reasoningMode, "full");

    await mkdir(join(workspace, ".ant"), { recursive: true });
    await writeFile(
      join(workspace, ".ant", "settings.json"),
      JSON.stringify({ ui: { showReasoning: false } }),
      "utf8",
    );

    assert.equal((await loadSettings(workspace, home)).settings.ui.reasoningMode, "off");
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("saving reasoning mode reports malformed global settings", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(join(home, ".ant", "settings.json"), "{", "utf8");

    await assert.rejects(saveUserReasoningMode("compact", home), /некорректный JSON/u);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("settings reject invalid reasoning display settings", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(workspace, ".ant"), { recursive: true });
    const path = join(workspace, ".ant", "settings.json");
    await writeFile(path, JSON.stringify({ ui: { reasoningMode: "window" } }), "utf8");
    await assert.rejects(loadSettings(workspace, home), /reasoningMode.*off, compact или full/u);

    await writeFile(path, JSON.stringify({ ui: { reasoningMaxLines: 0 } }), "utf8");
    await assert.rejects(loadSettings(workspace, home), /reasoningMaxLines.*положительным/u);

    await writeFile(path, JSON.stringify({ ui: { reasoningMaxLines: 21 } }), "utf8");
    await assert.rejects(loadSettings(workspace, home), /reasoningMaxLines.*от 1 до 20/u);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

test("settings preserve opaque provider options and reject invalid JSON", async () => {
  const { workspace, home } = await temporaryDirectories();

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await writeFile(
      join(home, ".ant", "settings.json"),
      '{"model":{"provider":"other","id":"other-model","options":{"window":123}}}',
      "utf8",
    );

    const loaded = await loadSettings(workspace, home);
    assert.deepEqual(loaded.settings.model, {
      providerId: "other",
      modelId: "other-model",
      providerOptions: { window: 123 },
    });

    await writeFile(join(home, ".ant", "settings.json"), "{", "utf8");
    await assert.rejects(loadSettings(workspace, home), /некорректный JSON/u);
  } finally {
    await rm(join(workspace, ".."), { recursive: true, force: true });
  }
});

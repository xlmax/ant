import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  AntApplication,
  type AntApplicationModules,
  type ApplicationOutput,
} from "../src/app/application.js";
import type { AntFrontend, FrontendOptions } from "../src/app/frontend.js";
import type { ModelProvider } from "../src/app/model-provider.js";
import type { LoadedSettings } from "../src/config/settings.js";
import type { SettingsModule } from "../src/config/settings-module.js";
import type { AgentModel } from "../src/core/agent.js";
import type { ContextSummarizer } from "../src/core/context-events.js";
import { ToolEnvironment } from "../src/core/environment.js";
import type { AgentRuntime } from "../src/core/runtime.js";
import type { SessionList, SessionStore } from "../src/core/session.js";
import { VERSION } from "../src/version.js";

const loadedSettings: LoadedSettings = {
  settings: {
    model: {
      provider: "deepseek",
      id: "test-model",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 10_000,
      vision: false,
      thinking: { enabled: true, effort: "high" },
    },
    ui: { showReasoning: false, showChanges: false, color: false },
    prompts: { additionalPaths: ["extra.md"] },
    tools: {},
    limits: {
      turnTimeoutSeconds: 60,
      modelRequestTimeoutSeconds: 10,
      modelMaxAttempts: 2,
    },
    verification: {
      enabled: true,
      maxRounds: 2,
      checks: ["empty-answer"],
    },
  },
  sources: [],
  projectOverrides: {
    modelId: false,
    modelThinking: false,
    showReasoning: false,
    showChanges: false,
  },
};

interface Harness {
  application: AntApplication;
  calls: string[];
  output: { logs: string[]; errors: string[] };
  frontendOptions(): FrontendOptions | undefined;
}

function createHarness(sessionList: SessionList = { sessions: [], warnings: [] }): Harness {
  const calls: string[] = [];
  const outputState = { logs: [] as string[], errors: [] as string[] };
  const output: ApplicationOutput = {
    log(message) {
      outputState.logs.push(message);
    },
    error(message) {
      outputState.errors.push(message);
    },
  };
  let capturedFrontendOptions: FrontendOptions | undefined;

  const settings: SettingsModule = {
    async load(workspace) {
      calls.push(`settings.load:${workspace}`);
      return loadedSettings;
    },
    async readExplicitVision(workspace) {
      calls.push(`settings.vision:${workspace}`);
      return undefined;
    },
    resolveVision(id, configured) {
      calls.push(`settings.resolve:${id}/${String(configured)}`);
      return configured ?? /vision/iu.test(id);
    },
    async saveModelId(id) {
      calls.push(`settings.model:${id}`);
    },
    async saveThinking(thinking) {
      calls.push(`settings.thinking:${thinking.enabled}/${thinking.effort}`);
    },
    async saveShowReasoning(enabled) {
      calls.push(`settings.reasoning:${enabled}`);
    },
  };

  const store: SessionStore = {
    async create() {
      throw new Error("create is owned by the frontend and not used in this test");
    },
    async list() {
      calls.push("sessions.list");
      return sessionList;
    },
    async resume() {
      throw new Error("resume is owned by the frontend and not used in this test");
    },
  };
  const model: AgentModel = {
    async decide() {
      return { type: "finish", answer: "ok" };
    },
  };
  const summarizer: ContextSummarizer = {
    async summarize() {
      return "summary";
    },
  };
  const provider: ModelProvider = {
    createAgentModel() {
      return model;
    },
    createContextSummarizer() {
      return summarizer;
    },
    async listModels() {
      return ["test-model"];
    },
  };
  const runtime: AgentRuntime = {
    async run(state) {
      return { status: "completed", answer: "ok", state };
    },
  };
  const environment = new ToolEnvironment([]);

  const modules: AntApplicationModules = {
    runtime,
    settings,
    applyEnvironment(workspace) {
      calls.push(`environment.apply:${workspace}`);
    },
    async loadSystemPrompt(workspace, additionalPaths) {
      calls.push(`prompt:${workspace}:${additionalPaths.join(",")}`);
      return { content: "system prompt", sources: ["SYSTEM.md"] };
    },
    createProvider(options) {
      calls.push(`provider:${options.systemPrompt}`);
      return provider;
    },
    createSessionStore(directory) {
      calls.push(`sessions.create:${directory}`);
      return store;
    },
    createEnvironment(workspace, options) {
      calls.push(`tools:${workspace}:${options.bashPath ?? "default"}`);
      return environment;
    },
    createFrontend(options) {
      calls.push(`frontend.create:${options.task}`);
      capturedFrontendOptions = options;
      const frontend: AntFrontend = {
        async run(host) {
          calls.push("frontend.run");
          assert.equal(host.runtime, runtime);
          assert.equal(host.provider, provider);
          assert.equal(host.sessions, store);
          assert.equal(host.environment, environment);
        },
      };
      return frontend;
    },
    output,
  };

  return {
    application: new AntApplication(modules),
    calls,
    output: outputState,
    frontendOptions: () => capturedFrontendOptions,
  };
}

test("AntApplication builds modules in order and delegates settings mutations", async () => {
  const harness = createHarness();
  const workspace = join("temporary", "workspace");

  await harness.application.run({ workspace, args: ["Выполни задачу"] });

  assert.deepEqual(harness.calls, [
    `environment.apply:${workspace}`,
    `sessions.create:${join(workspace, ".ant", "sessions")}`,
    `settings.load:${workspace}`,
    `prompt:${workspace}:extra.md`,
    "provider:system prompt",
    `tools:${workspace}:default`,
    "frontend.create:Выполни задачу",
    "frontend.run",
  ]);

  const options = harness.frontendOptions();
  assert.ok(options);
  assert.equal(options.modelSettings, loadedSettings.settings.model);
  assert.equal(await options.settings.saveModelId("custom-vision"), true);
  await options.settings.saveThinking({ enabled: false, effort: "max" });
  await options.settings.saveShowReasoning(true);
  assert.deepEqual(harness.calls.slice(-5), [
    "settings.model:custom-vision",
    `settings.vision:${workspace}`,
    "settings.resolve:custom-vision/undefined",
    "settings.thinking:false/max",
    "settings.reasoning:true",
  ]);
});

test("AntApplication handles help and version before creating runtime modules", async () => {
  const help = createHarness();
  await help.application.run({ workspace: "workspace", args: ["-h"] });
  assert.deepEqual(help.calls, ["environment.apply:workspace"]);
  assert.match(help.output.logs[0] ?? "", /Использование: ant/u);

  const version = createHarness();
  await version.application.run({ workspace: "workspace", args: ["-v"] });
  assert.deepEqual(version.calls, ["environment.apply:workspace"]);
  assert.equal(version.output.logs[0], VERSION);
});

test("AntApplication lists sessions without loading model settings", async () => {
  const harness = createHarness({
    sessions: [
      {
        id: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        task: "Сохранённая задача",
      },
    ],
    warnings: ["повреждённая сессия"],
  });

  await harness.application.run({ workspace: "workspace", args: ["-r"] });

  assert.deepEqual(harness.calls, [
    "environment.apply:workspace",
    `sessions.create:${join("workspace", ".ant", "sessions")}`,
    "sessions.list",
  ]);
  assert.deepEqual(harness.output.errors, ["Предупреждение: повреждённая сессия"]);
  assert.match(harness.output.logs.join("\n"), /session-1.*Сохранённая задача/u);
});

test("AntApplication resolves the latest session before starting the frontend", async () => {
  const harness = createHarness({
    sessions: [
      {
        id: "latest-session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        task: "Задача",
      },
    ],
    warnings: [],
  });

  await harness.application.run({ workspace: "workspace", args: ["-c", "Продолжи"] });

  assert.equal(harness.frontendOptions()?.resume, "latest-session");
  assert.ok(
    harness.calls.indexOf("sessions.list") < harness.calls.indexOf("settings.load:workspace"),
  );
});

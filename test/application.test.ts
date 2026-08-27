import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  type LoadedConfiguration,
  type SettingsModule,
} from "../packages/app/src/configuration.js";
import { AntApplication, type AntApplicationModules } from "../packages/app/src/application.js";
import type { AntApplicationApi } from "../packages/app/src/application-client.js";
import type { AntFrontend, FrontendOptions } from "../packages/app/src/frontend.js";
import type { ModelProvider } from "../packages/app/src/model-provider.js";
import type { SessionList, SessionStore } from "../packages/app/src/session.js";
import type { AgentModel } from "../packages/core/src/agent.js";
import type { ContextSummarizer } from "../packages/core/src/context-events.js";
import { ToolEnvironment } from "../packages/tools-coding/src/tool-environment.js";
import type { AgentRuntime } from "../packages/core/src/runtime.js";

const loadedValues: Record<string, unknown> = {
  model: {
    providerId: "test",
    modelId: "test-model",
    providerOptions: { contextWindow: 10_000, vision: false, effort: "high" },
  },
  ui: { reasoningMode: "off", reasoningMaxLines: 6, showChanges: false, color: false },
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
};

const loadedSettings: LoadedConfiguration = {
  configuration: {
    sources: [],
    get: (key) => loadedValues[key.namespace] as never,
    isProjectOverride: () => false,
  },
};

interface Harness {
  application: AntApplication;
  calls: string[];
  frontendOptions(): FrontendOptions | undefined;
  frontendClient(): AntApplicationApi | undefined;
}

function createHarness(sessionList: SessionList = { sessions: [], warnings: [] }): Harness {
  const calls: string[] = [];
  let capturedFrontendOptions: FrontendOptions | undefined;
  let capturedFrontendClient: AntApplicationApi | undefined;

  const settings: SettingsModule = {
    async load(workspace) {
      calls.push(`settings.load:${workspace}`);
      return loadedSettings;
    },
    async saveModelId(id) {
      calls.push(`settings.model:${id}`);
    },
    async saveModelProviderOptions(providerId, update) {
      const value = update as { effort: string };
      calls.push(`settings.options:${providerId}/${value.effort}`);
    },
    async saveReasoningMode(mode) {
      calls.push(`settings.reasoning:${mode}`);
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
    async append() {
      throw new Error("append is not used in this test");
    },
    async read() {
      throw new Error("read is not used in this test");
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
    id: "test",
    describe(configuration) {
      const options = configuration.providerOptions as {
        contextWindow: number;
        vision: boolean;
        effort: string;
      };
      return {
        providerId: "test",
        modelId: configuration.modelId,
        contextWindow: options.contextWindow,
        capabilities: {
          vision: options.vision,
          reasoning: {
            supported: true,
            enabled: options.effort !== "off",
            ...(options.effort === "off" ? {} : { effort: options.effort }),
            availableEfforts: ["high", "max"],
          },
        },
      };
    },
    createAgentModel() {
      return model;
    },
    createContextSummarizer() {
      return summarizer;
    },
    async listModels() {
      return ["test-model"];
    },
    selectModel(configuration, modelId) {
      return {
        ...configuration,
        modelId,
        providerOptions: {
          ...(configuration.providerOptions as object),
          vision: modelId.includes("vision"),
        },
      };
    },
    selectReasoning(configuration, selection) {
      const effort = selection === "off" ? "off" : selection;
      return {
        configuration: {
          ...configuration,
          providerOptions: { ...(configuration.providerOptions as object), effort },
        },
        settingsUpdate: { effort },
      };
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
    async loadSystemPrompt(workspace, additionalPaths) {
      calls.push(`prompt:${workspace}:${additionalPaths.join(",")}`);
      return { content: "system prompt", sources: ["SYSTEM.md"] };
    },
    createProvider(options) {
      calls.push(`provider:${options.systemPrompt}`);
      return provider;
    },
    createSessionStore(workspace) {
      calls.push(`sessions.create:${workspace}`);
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
        async run(client) {
          calls.push("frontend.run");
          capturedFrontendClient = client;
          assert.equal(client.modelDescriptor.modelId, "test-model");
        },
      };
      return frontend;
    },
  };

  return {
    application: new AntApplication(modules),
    calls,
    frontendOptions: () => capturedFrontendOptions,
    frontendClient: () => capturedFrontendClient,
  };
}

test("AntApplication builds modules in order and delegates settings mutations", async () => {
  const harness = createHarness();
  const workspace = join("temporary", "workspace");

  await harness.application.run({ workspace, task: "Выполни задачу" });

  assert.deepEqual(harness.calls, [
    `sessions.create:${workspace}`,
    `settings.load:${workspace}`,
    `prompt:${workspace}:extra.md`,
    "provider:system prompt",
    `tools:${workspace}:default`,
    "frontend.create:Выполни задачу",
    "frontend.run",
  ]);

  const options = harness.frontendOptions();
  const client = harness.frontendClient();
  assert.ok(options);
  assert.ok(client);
  assert.equal((await client.selectModel("custom-vision")).descriptor.capabilities.vision, true);
  await client.selectThinking("off");
  await client.selectThinking("max");
  await options.settings.saveReasoningMode("compact");
  assert.deepEqual(harness.calls.slice(-4), [
    "settings.model:custom-vision",
    "settings.options:test/off",
    "settings.options:test/max",
    "settings.reasoning:compact",
  ]);
});

test("AntApplication lists sessions without creating infrastructure paths", async () => {
  const list: SessionList = {
    sessions: [
      {
        id: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        task: "Сохранённая задача",
      },
    ],
    warnings: ["повреждённая сессия"],
  };
  const harness = createHarness(list);

  assert.equal(await harness.application.listSessions("workspace"), list);
  assert.deepEqual(harness.calls, ["sessions.create:workspace", "sessions.list"]);
});

test("AntApplication resolves the latest session before loading settings", async () => {
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

  await harness.application.run({
    workspace: "workspace",
    task: "Продолжи",
    continueLatest: true,
  });

  assert.equal(harness.frontendOptions()?.resume, "latest-session");
  assert.ok(
    harness.calls.indexOf("sessions.list") < harness.calls.indexOf("settings.load:workspace"),
  );
});

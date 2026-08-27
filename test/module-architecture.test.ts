import assert from "node:assert/strict";
import test from "node:test";

import { AntApplicationClient } from "../packages/app/src/application-client.js";
import type { AntFrontend } from "../packages/app/src/frontend.js";
import type { ModelConfiguration, ModelProvider } from "../packages/app/src/model-provider.js";
import type { AgentModel, Environment } from "../packages/core/src/agent.js";
import type { ContextSummarizer } from "../packages/core/src/context-events.js";
import type { AgentRuntime } from "../packages/core/src/runtime.js";
import { MemorySessionStore } from "../packages/session-jsonl/src/memory-session-store.js";

const configuration: ModelConfiguration = {
  providerId: "test",
  modelId: "test-model",
  providerOptions: { contextWindow: 10_000 },
};

test("application client composes replaceable runtime, provider, session, and environment modules", async () => {
  const calls: string[] = [];
  const model: AgentModel = {
    async decide() {
      throw new Error("The custom runtime must own the loop");
    },
  };
  const summarizer: ContextSummarizer = {
    async summarize() {
      return "summary";
    },
  };
  const runtime: AgentRuntime = {
    async run(state, dependencies) {
      calls.push("runtime");
      assert.equal(dependencies.model, model);
      return { status: "completed", answer: "alternative core", state };
    },
  };
  const provider: ModelProvider = {
    id: "test",
    describe(received) {
      assert.equal(received, configuration);
      return {
        providerId: "test",
        modelId: received.modelId,
        contextWindow: 10_000,
        capabilities: {
          vision: false,
          reasoning: { supported: false, enabled: false, availableEfforts: [] },
        },
      };
    },
    createAgentModel(received) {
      calls.push("provider.model");
      assert.equal(received, configuration);
      return model;
    },
    createContextSummarizer(received) {
      calls.push("provider.summarizer");
      assert.equal(received, configuration);
      return summarizer;
    },
    async listModels(received) {
      calls.push("provider.list");
      assert.equal(received, configuration);
      return ["test-model"];
    },
    selectModel(received, modelId) {
      return { ...received, modelId };
    },
    selectReasoning() {
      throw new Error("reasoning is unsupported");
    },
  };
  const sessions = new MemorySessionStore();
  const environment: Environment = {
    tools: () => [],
    async execute() {
      return { ok: true, value: "fake environment" };
    },
    async executeMany() {
      return [];
    },
  };
  const client = new AntApplicationClient({
    runtime,
    provider,
    sessions,
    environment,
    systemPrompt: "system prompt",
    modelConfiguration: configuration,
    settings: {
      async saveModelId() {},
      async saveModelProviderOptions() {},
    },
    limits: {
      turnTimeoutSeconds: 60,
      modelRequestTimeoutSeconds: 10,
      modelMaxAttempts: 1,
    },
  });

  const frontend: AntFrontend = {
    async run(received) {
      calls.push("frontend");
      assert.equal(received, client);
      assert.equal(received.modelDescriptor.modelId, "test-model");
      assert.deepEqual(await received.listModels(), ["test-model"]);
      const submitted = await received.submitTurn("task");
      assert.equal(submitted.result.status, "completed");
      if (submitted.result.status === "completed") {
        assert.equal(submitted.result.answer, "alternative core");
      }
    },
  };

  await frontend.run(client);
  assert.deepEqual(calls, [
    "provider.model",
    "provider.summarizer",
    "frontend",
    "provider.list",
    "runtime",
  ]);
});

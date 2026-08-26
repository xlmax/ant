import assert from "node:assert/strict";
import test from "node:test";

import { AntHost } from "../src/app/ant-host.js";
import type { AntFrontend } from "../src/app/frontend.js";
import type { ModelProvider } from "../src/app/model-provider.js";
import type { ModelSettings } from "../src/config/settings.js";
import { createAgentState, type AgentModel, type AgentState } from "../src/core/agent.js";
import type { ContextSummarizer } from "../src/core/context-events.js";
import { ToolEnvironment } from "../src/core/environment.js";
import type { AgentRuntime } from "../src/core/runtime.js";
import type { SessionList, SessionStore } from "../src/core/session.js";

const settings: ModelSettings = {
  provider: "deepseek",
  id: "test-model",
  baseUrl: "https://example.test",
  contextWindow: 10_000,
  vision: false,
  thinking: { enabled: false, effort: "low" },
};

class MemorySessionStore implements SessionStore {
  readonly #states = new Map<string, AgentState>();

  async create(state: AgentState) {
    const id = `session-${this.#states.size + 1}`;
    this.#states.set(id, state);
    return {
      id,
      observer: { onEvent: () => {} },
    };
  }

  async list(): Promise<SessionList> {
    return { sessions: [], warnings: [] };
  }

  async resume(sessionId: string) {
    const state = this.#states.get(sessionId);
    if (!state) throw new Error(`Unknown session: ${sessionId}`);
    return {
      state,
      session: {
        id: sessionId,
        observer: { onEvent: () => {} },
      },
    };
  }
}

test("AntHost composes replaceable runtime, frontend, provider, and session modules", async () => {
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
    createAgentModel(received) {
      calls.push("provider.model");
      assert.equal(received, settings);
      return model;
    },
    createContextSummarizer(received) {
      calls.push("provider.summarizer");
      assert.equal(received, settings);
      return summarizer;
    },
    async listModels(received) {
      calls.push("provider.list");
      assert.equal(received, settings);
      return ["test-model"];
    },
  };
  const sessions = new MemorySessionStore();
  const environment = new ToolEnvironment([]);
  const host = new AntHost({ runtime, provider, sessions, environment });

  const frontend: AntFrontend = {
    async run(context) {
      calls.push("frontend");
      assert.equal(context.provider, provider);
      assert.equal(context.sessions, sessions);
      assert.equal(context.environment, environment);

      const activeModel = context.provider.createAgentModel(settings);
      assert.equal(context.provider.createContextSummarizer(settings), summarizer);
      assert.deepEqual(await context.provider.listModels(settings), ["test-model"]);
      const state = createAgentState("task");
      const session = await context.sessions.create(state);
      const result = await context.runtime.run(state, {
        model: activeModel,
        environment: context.environment,
        historyObserver: session.observer,
      });
      assert.equal(result.status, "completed");
      if (result.status === "completed") assert.equal(result.answer, "alternative core");
    },
  };

  await host.run(frontend);
  assert.deepEqual(calls, [
    "frontend",
    "provider.model",
    "provider.summarizer",
    "provider.list",
    "runtime",
  ]);
});

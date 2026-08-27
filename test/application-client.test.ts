import assert from "node:assert/strict";
import test from "node:test";

import {
  AntApplicationClient,
  type ApplicationClientDependencies,
} from "../src/app/application-client.js";
import type { ModelSettings } from "../src/app/configuration.js";
import type { ModelProvider } from "../src/app/model-provider.js";
import type { AgentSession, SessionStore } from "../src/app/session.js";
import type {
  AgentDependencies,
  AgentEvent,
  AgentModel,
  AgentObserver,
  AgentState,
  HistoryEvent,
} from "../src/core/agent.js";
import type { ContextSummarizer } from "../src/core/context-events.js";
import type { AgentRuntime } from "../src/core/runtime.js";
import { ToolEnvironment } from "../src/tools/tool-environment.js";

const initialSettings: ModelSettings = {
  provider: "deepseek",
  id: "model-a",
  baseUrl: "https://example.test",
  contextWindow: 10_000,
  vision: false,
  thinking: { enabled: true, effort: "high" },
};

interface Harness {
  client: AntApplicationClient;
  records: HistoryEvent[];
  calls: string[];
  runtimeDependencies: AgentDependencies[];
  failModelSave: boolean;
  failThinkingSave: boolean;
  summaryText: string;
}

function createHarness(): Harness {
  const calls: string[] = [];
  const records: HistoryEvent[] = [];
  const runtimeDependencies: AgentDependencies[] = [];
  let failModelSave = false;
  let failThinkingSave = false;
  let summaryText = "summary";
  let nextSession = 1;

  const observer: AgentObserver = {
    onEvent(event) {
      if (
        event.type === "task" ||
        event.type === "user" ||
        event.type === "decision" ||
        event.type === "observation" ||
        event.type === "compaction" ||
        event.type === "verification"
      ) {
        records.push(event);
      }
    },
  };
  const session = (id: string): AgentSession => ({ id, observer, location: `/sessions/${id}` });
  const resumedState: AgentState = { events: [{ type: "task", content: "resumed" }] };
  const store: SessionStore = {
    async create(state) {
      calls.push(`session.create:${state.events[0]?.type}`);
      await observer.onEvent(state.events[0] as HistoryEvent);
      return session(`session-${nextSession++}`);
    },
    async list() {
      return { sessions: [], warnings: [] };
    },
    async resume(id) {
      calls.push(`session.resume:${id}`);
      return { state: resumedState, session: session(id) };
    },
  };

  const createModel = (id: string): AgentModel => ({
    async decide() {
      return { type: "finish", answer: id };
    },
  });
  const createSummarizer = (id: string): ContextSummarizer => ({
    async summarize() {
      calls.push(`summarize:${id}`);
      return summaryText;
    },
  });
  const provider: ModelProvider = {
    createAgentModel(settings) {
      calls.push(
        `model.create:${settings.id}:${settings.thinking.enabled}/${settings.thinking.effort}`,
      );
      return createModel(settings.id);
    },
    createContextSummarizer(settings) {
      calls.push(
        `summarizer.create:${settings.id}:${settings.thinking.enabled}/${settings.thinking.effort}`,
      );
      return createSummarizer(settings.id);
    },
    async listModels(settings) {
      calls.push(`models.list:${settings.id}`);
      return ["model-a", "model-b"];
    },
  };
  const runtime: AgentRuntime = {
    async run(state, dependencies) {
      calls.push(`runtime:${state.events.at(-1)?.type}`);
      runtimeDependencies.push(dependencies);
      const decision = { type: "finish" as const, answer: "done" };
      await dependencies.historyObserver?.onEvent({ type: "decision", decision });
      state.events.push({ type: "decision", decision });
      for (const target of dependencies.observers ?? []) {
        await target.onEvent({ type: "decision", decision });
      }
      return { status: "completed", answer: "done", state };
    },
  };

  const dependencies: ApplicationClientDependencies = {
    runtime,
    provider,
    sessions: store,
    environment: new ToolEnvironment([]),
    systemPrompt: "system",
    modelSettings: initialSettings,
    limits: {
      turnTimeoutSeconds: 60,
      modelRequestTimeoutSeconds: 5,
      modelMaxAttempts: 2,
    },
    verification: { enabled: true, maxRounds: 1, checks: ["empty-answer"] },
    settings: {
      async saveModelId(id) {
        calls.push(`model.save:${id}`);
        if (failModelSave) throw new Error("save failed");
        return id === "model-b";
      },
      async saveThinking(thinking) {
        calls.push(`thinking.save:${thinking.enabled}/${thinking.effort}`);
        if (failThinkingSave) throw new Error("thinking save failed");
      },
    },
  };

  const harness: Harness = {
    client: new AntApplicationClient(dependencies),
    records,
    calls,
    runtimeDependencies,
    get failModelSave() {
      return failModelSave;
    },
    set failModelSave(value: boolean) {
      failModelSave = value;
    },
    get failThinkingSave() {
      return failThinkingSave;
    },
    set failThinkingSave(value: boolean) {
      failThinkingSave = value;
    },
    get summaryText() {
      return summaryText;
    },
    set summaryText(value: string) {
      summaryText = value;
    },
  };
  return harness;
}

test("application client owns models and exposes read-only state", () => {
  const harness = createHarness();

  assert.equal(harness.client.modelSettings.id, "model-a");
  assert.equal(harness.client.activeSession, undefined);
  assert.deepEqual(harness.calls, [
    "model.create:model-a:true/high",
    "summarizer.create:model-a:true/high",
  ]);
});

test("submitTurn creates and continues a session through one application path", async () => {
  const harness = createHarness();
  const observed: AgentEvent[] = [];
  const observer: AgentObserver = {
    onEvent(event) {
      observed.push(event);
    },
  };
  const abort = new AbortController();

  const first = await harness.client.submitTurn("first", {
    observers: [observer],
    signal: abort.signal,
  });
  const second = await harness.client.submitTurn("second", { observers: [observer] });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.session.id, "session-1");
  assert.equal(harness.client.activeSession?.session.id, "session-1");
  assert.deepEqual(
    first.result.state.events.map((event) => event.type),
    ["task", "decision", "user", "decision"],
  );
  assert.deepEqual(
    harness.records.map((event) => event.type),
    ["task", "decision", "user", "decision"],
  );
  assert.equal(harness.runtimeDependencies[0]?.modelRequestTimeoutMs, 5_000);
  assert.equal(harness.runtimeDependencies[0]?.modelMaxAttempts, 2);
  assert.deepEqual(harness.runtimeDependencies[0]?.verification, {
    enabled: true,
    maxRounds: 1,
    checks: ["empty-answer"],
  });
  assert.ok(harness.runtimeDependencies[0]?.signal);
  assert.deepEqual(
    observed.map((event) => event.type),
    ["decision", "decision"],
  );
});

test("resume and reset session are application operations", async () => {
  const harness = createHarness();

  const resumed = await harness.client.resumeSession("saved-session");
  assert.equal(resumed.session.id, "saved-session");
  assert.equal(harness.client.activeSession?.session.id, "saved-session");

  harness.client.resetSession();
  assert.equal(harness.client.activeSession, undefined);

  const submitted = await harness.client.submitTurn("new task");
  assert.equal(submitted.created, true);
  assert.equal(submitted.session.id, "session-1");
});

test("model and thinking selections persist before rebuilding model clients", async () => {
  const harness = createHarness();

  const selected = await harness.client.selectModel("model-b");
  assert.equal(selected.changed, true);
  assert.equal(selected.settings.id, "model-b");
  assert.equal(selected.settings.vision, true);
  assert.deepEqual(harness.calls.slice(-3), [
    "model.save:model-b",
    "model.create:model-b:true/high",
    "summarizer.create:model-b:true/high",
  ]);

  const thinking = await harness.client.selectThinking("off");
  assert.equal(thinking.changed, true);
  assert.deepEqual(thinking.settings.thinking, { enabled: false, effort: "high" });
  assert.deepEqual(harness.calls.slice(-3), [
    "thinking.save:false/high",
    "model.create:model-b:false/high",
    "summarizer.create:model-b:false/high",
  ]);

  await harness.client.selectThinking("max");
  assert.deepEqual(harness.client.modelSettings.thinking, { enabled: true, effort: "max" });
});

test("failed model persistence leaves active model unchanged", async () => {
  const harness = createHarness();
  harness.failModelSave = true;

  await assert.rejects(() => harness.client.selectModel("model-b"), /save failed/u);
  assert.equal(harness.client.modelSettings.id, "model-a");
  assert.equal(harness.calls.filter((call) => call.startsWith("model.create")).length, 1);
});

test("failed thinking persistence leaves active model unchanged", async () => {
  const harness = createHarness();
  harness.failThinkingSave = true;

  await assert.rejects(() => harness.client.selectThinking("off"), /thinking save failed/u);
  assert.deepEqual(harness.client.modelSettings.thinking, { enabled: true, effort: "high" });
  assert.equal(harness.calls.filter((call) => call.startsWith("model.create")).length, 1);
});

test("listModels and context status use application-owned state", async () => {
  const harness = createHarness();
  await harness.client.submitTurn("task");

  assert.deepEqual(await harness.client.listModels(), ["model-a", "model-b"]);
  const context = harness.client.getContextStatus();
  assert.equal(context.contextWindow, 10_000);
  assert.ok(context.estimatedTokens > 0);
});

test("compactContext persists only a smaller valid compaction", async () => {
  const harness = createHarness();
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");

  const result = await harness.client.compactContext();

  assert.equal(result.status, "compacted");
  if (result.status !== "compacted") return;
  assert.equal(result.retainedUserTurns, 2);
  assert.ok(result.after.estimatedTokens < result.before.estimatedTokens);
  assert.equal(harness.records.at(-1)?.type, "compaction");
});

test("compactContext does not mutate a missing or short session", async () => {
  const harness = createHarness();

  assert.deepEqual(await harness.client.compactContext(), { status: "no-session" });
  await harness.client.submitTurn("one");
  assert.deepEqual(await harness.client.compactContext(), { status: "not-enough-history" });
  assert.notEqual(harness.records.at(-1)?.type, "compaction");
});

test("compactContext does not persist a summary that increases context", async () => {
  const harness = createHarness();
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");
  const eventsBefore = harness.records.length;
  harness.summaryText = "very long summary ".repeat(2_000);

  const result = await harness.client.compactContext();

  assert.equal(result.status, "not-smaller");
  assert.equal(harness.records.length, eventsBefore);
  assert.notEqual(harness.records.at(-1)?.type, "compaction");
});

test("submitTurn announces the prepared session before invoking runtime", async () => {
  const harness = createHarness();

  await harness.client.submitTurn("task", {
    onSessionPrepared(session, created) {
      harness.calls.push(`prepared:${session.id}/${String(created)}`);
    },
  });

  assert.ok(
    harness.calls.indexOf("prepared:session-1/true") < harness.calls.indexOf("runtime:task"),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  AntApplicationClient,
  type ApplicationClientDependencies,
  type AutoCompactionEvent,
} from "../packages/app/src/application-client.js";
import type { ContextSettings } from "../packages/app/src/configuration.js";
import type {
  ModelConfiguration,
  ModelDescriptor,
  ModelProvider,
} from "../packages/app/src/model-provider.js";
import type { AgentSession, SessionStore } from "../packages/app/src/session.js";
import { decodeHistoryEvent, encodeHistoryEvent } from "../packages/app/src/session-codec.js";
import type {
  AgentDependencies,
  AgentEvent,
  AgentModel,
  AgentObserver,
  AgentState,
  HistoryEvent,
} from "../packages/core/src/agent.js";
import type { ContextSummarizer } from "../packages/core/src/context-events.js";
import type { AgentRuntime } from "../packages/core/src/runtime.js";
import { ToolEnvironment } from "../packages/tools-coding/src/tool-environment.js";

interface TestProviderOptions {
  contextWindow: number;
  vision: boolean;
  thinking: { enabled: boolean; effort: string };
}

const initialConfiguration: ModelConfiguration = {
  providerId: "test",
  modelId: "model-a",
  providerOptions: {
    contextWindow: 10_000,
    vision: false,
    thinking: { enabled: true, effort: "high" },
  } satisfies TestProviderOptions,
};

function testOptions(configuration: ModelConfiguration): TestProviderOptions {
  return configuration.providerOptions as TestProviderOptions;
}

interface Harness {
  client: AntApplicationClient;
  records: HistoryEvent[];
  calls: string[];
  runtimeDependencies: AgentDependencies[];
  failModelSave: boolean;
  failThinkingSave: boolean;
  failSummary: boolean;
  summaryText: string;
  contextSettings: ContextSettings;
}

function createHarness(): Harness {
  const calls: string[] = [];
  const records: HistoryEvent[] = [];
  const runtimeDependencies: AgentDependencies[] = [];
  let failModelSave = false;
  let failThinkingSave = false;
  let failSummary = false;
  let summaryText = "summary";
  const contextSettings: ContextSettings = {
    autoCompact: false,
    autoCompactThreshold: 0.8,
  };
  let nextSession = 1;

  const session = (id: string): AgentSession => ({ id, location: `/sessions/${id}` });
  const resumedState: AgentState = {
    events: [
      { type: "task", content: "resumed" },
      { type: "decision", decision: { type: "finish", answer: "saved" } },
      {
        type: "compaction",
        summary: "previous turn compacted",
        retainedEvents: [
          { type: "task", content: "resumed" },
          { type: "decision", decision: { type: "finish", answer: "saved" } },
        ],
      },
    ],
  };
  const store: SessionStore = {
    async create(input) {
      calls.push("session.create:task");
      records.push(...input.payloads.map(decodeHistoryEvent));
      return session(`session-${nextSession++}`);
    },
    async append(id, payload) {
      const event = decodeHistoryEvent(payload);
      records.push(event);
      return { schemaVersion: 2, sessionId: id, timestamp: new Date().toISOString(), payload };
    },
    async read(id) {
      calls.push(`session.resume:${id}`);
      return {
        session: session(id),
        records: resumedState.events.map((event) => ({
          schemaVersion: 2 as const,
          sessionId: id,
          timestamp: new Date().toISOString(),
          payload: encodeHistoryEvent(event),
        })),
      };
    },
    async list() {
      return { sessions: [], warnings: [] };
    },
    async deleteAll() {
      calls.push("sessions.deleteAll");
      return 2;
    },
  };

  const createModel = (id: string): AgentModel => ({
    async decide(_input, _signal, onTextDelta, _onReasoningDelta, _onUsage, onActivity) {
      onActivity?.();
      onTextDelta?.("OK");
      return { type: "finish", answer: id };
    },
  });
  const createSummarizer = (id: string): ContextSummarizer => ({
    async summarize() {
      calls.push(`summarize:${id}`);
      if (failSummary) throw new Error("summary failed");
      return summaryText;
    },
  });
  const provider: ModelProvider = {
    id: "test",
    describe(configuration): ModelDescriptor {
      const options = testOptions(configuration);
      return {
        providerId: "test",
        modelId: configuration.modelId,
        contextWindow: options.contextWindow,
        capabilities: {
          vision: options.vision,
          reasoning: {
            supported: true,
            enabled: options.thinking.enabled,
            ...(options.thinking.enabled ? { effort: options.thinking.effort } : {}),
            availableEfforts: ["low", "high", "max"],
          },
        },
      };
    },
    createAgentModel(configuration) {
      const thinking = testOptions(configuration).thinking;
      calls.push(`model.create:${configuration.modelId}:${thinking.enabled}/${thinking.effort}`);
      return createModel(configuration.modelId);
    },
    createContextSummarizer(configuration) {
      const thinking = testOptions(configuration).thinking;
      calls.push(
        `summarizer.create:${configuration.modelId}:${thinking.enabled}/${thinking.effort}`,
      );
      return createSummarizer(configuration.modelId);
    },
    async listModels(configuration) {
      calls.push(`models.list:${configuration.modelId}`);
      return ["model-a", "model-b"];
    },
    selectModel(configuration, modelId) {
      return {
        ...configuration,
        modelId,
        providerOptions: { ...testOptions(configuration), vision: modelId === "model-b" },
      };
    },
    selectReasoning(configuration, selection) {
      const options = testOptions(configuration);
      const thinking = {
        enabled: selection !== "off",
        effort: selection === "off" ? options.thinking.effort : selection,
      };
      return {
        configuration: {
          ...configuration,
          providerOptions: { ...options, thinking },
        },
        settingsUpdate: { thinking },
      };
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
    modelConfiguration: initialConfiguration,
    limits: {
      turnTimeoutSeconds: 60,
      modelRequestTimeoutSeconds: 5,
      modelMaxAttempts: 2,
    },
    context: contextSettings,
    verification: { enabled: true, maxRounds: 1, checks: ["empty-answer"] },
    settings: {
      async saveModelId(id) {
        calls.push(`model.save:${id}`);
        if (failModelSave) throw new Error("save failed");
      },
      async saveModelProviderOptions(providerId, update) {
        const thinking = (update as { thinking: { enabled: boolean; effort: string } }).thinking;
        calls.push(`thinking.save:${providerId}:${thinking.enabled}/${thinking.effort}`);
        if (failThinkingSave) throw new Error("thinking save failed");
      },
    },
  };

  const harness: Harness = {
    client: new AntApplicationClient(dependencies),
    records,
    calls,
    runtimeDependencies,
    contextSettings,
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
    get failSummary() {
      return failSummary;
    },
    set failSummary(value: boolean) {
      failSummary = value;
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

  assert.equal(harness.client.modelDescriptor.modelId, "model-a");
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
  assert.deepEqual(
    harness.client.getLastTurnEvents()?.map((event) => event.type),
    ["task", "decision"],
  );

  harness.client.resetSession();
  assert.equal(harness.client.activeSession, undefined);

  const submitted = await harness.client.submitTurn("new task");
  assert.equal(submitted.created, true);
  assert.equal(submitted.session.id, "session-1");
});

test("deleting all sessions resets the active session", async () => {
  const harness = createHarness();
  await harness.client.submitTurn("task");

  assert.equal(await harness.client.deleteAllSessions(), 2);
  assert.equal(harness.client.activeSession, undefined);
  assert.equal(harness.calls.at(-1), "sessions.deleteAll");
});

test("last turn events expose the latest replayable slice", async () => {
  const harness = createHarness();

  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");

  assert.deepEqual(
    harness.client.getLastTurnEvents()?.map((event) => event.type),
    ["user", "decision"],
  );
});

test("model and thinking selections persist before rebuilding model clients", async () => {
  const harness = createHarness();

  const selected = await harness.client.selectModel("model-b");
  assert.equal(selected.changed, true);
  assert.equal(selected.descriptor.modelId, "model-b");
  assert.equal(selected.descriptor.capabilities.vision, true);
  assert.deepEqual(harness.calls.slice(-3), [
    "model.save:model-b",
    "model.create:model-b:true/high",
    "summarizer.create:model-b:true/high",
  ]);

  const thinking = await harness.client.selectThinking("off");
  assert.equal(thinking.changed, true);
  assert.equal(thinking.descriptor.capabilities.reasoning.enabled, false);
  assert.deepEqual(harness.calls.slice(-3), [
    "thinking.save:test:false/high",
    "model.create:model-b:false/high",
    "summarizer.create:model-b:false/high",
  ]);

  await harness.client.selectThinking("max");
  assert.equal(harness.client.modelDescriptor.capabilities.reasoning.effort, "max");
});

test("failed model persistence leaves active model unchanged", async () => {
  const harness = createHarness();
  harness.failModelSave = true;

  await assert.rejects(() => harness.client.selectModel("model-b"), /save failed/u);
  assert.equal(harness.client.modelDescriptor.modelId, "model-a");
  assert.equal(harness.calls.filter((call) => call.startsWith("model.create")).length, 1);
});

test("failed thinking persistence leaves active model unchanged", async () => {
  const harness = createHarness();
  harness.failThinkingSave = true;

  await assert.rejects(() => harness.client.selectThinking("off"), /thinking save failed/u);
  assert.equal(harness.client.modelDescriptor.capabilities.reasoning.effort, "high");
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

test("model diagnostics use the active model without creating a session", async () => {
  const harness = createHarness();
  const diagnostic = await harness.client.diagnoseModel();

  assert.ok(diagnostic.firstActivityMs >= 0);
  assert.ok(diagnostic.durationMs >= diagnostic.firstActivityMs);
  assert.equal(diagnostic.toolsEnabled, false);
  assert.equal(harness.client.activeSession, undefined);
  assert.deepEqual(harness.records, []);
  assert.ok(!harness.calls.some((call) => call.startsWith("session.create")));
});

test("automatic compaction stays idle below its configured threshold", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.99;
  await harness.client.submitTurn("one");
  const events: AutoCompactionEvent[] = [];

  await harness.client.submitTurn("two", {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, []);
  assert.equal(
    harness.calls.some((call) => call.startsWith("summarize:")),
    false,
  );
});

test("automatic compaction threshold includes the pending user message", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.5;
  await harness.client.submitTurn("one");
  assert.ok(harness.client.getContextStatus().percentage < 50);
  const events: AutoCompactionEvent[] = [];

  await harness.client.submitTurn("x".repeat(25_000), {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.equal(events.at(0)?.type, "started");
  assert.ok((events.at(0)?.before.percentage ?? 0) >= 50);
});

test("automatic compaction reports insufficient history without calling the summarizer", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.0001;
  await harness.client.submitTurn("one");
  const events: AutoCompactionEvent[] = [];

  const submitted = await harness.client.submitTurn("two", {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.equal(submitted.result.status, "completed");
  assert.deepEqual(
    events.map((event) =>
      event.type === "skipped" ? `${event.type}:${event.reason}` : event.type,
    ),
    ["started", "skipped:not-enough-history"],
  );
  assert.equal(
    harness.calls.some((call) => call.startsWith("summarize:")),
    false,
  );
});

test("submitTurn automatically compacts a large active context before appending the user", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.0001;
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");

  const events: AutoCompactionEvent[] = [];
  const submitted = await harness.client.submitTurn("four", {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.equal(submitted.result.status, "completed");
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "completed"],
  );
  const completed = events.at(-1);
  assert.ok(completed?.type === "completed");
  assert.ok(completed.after.estimatedTokens < completed.before.estimatedTokens);
  assert.ok(harness.records.some((event) => event.type === "compaction"));
  assert.equal(harness.records.at(-2)?.type, "user");
  assert.equal(harness.records.at(-1)?.type, "decision");
});

test("a failed automatic compaction keeps history and continues the turn", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.0001;
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");
  harness.failSummary = true;
  const events: AutoCompactionEvent[] = [];

  const submitted = await harness.client.submitTurn("four", {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.equal(submitted.result.status, "completed");
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "failed"],
  );
  assert.equal(
    harness.records.some((event) => event.type === "compaction"),
    false,
  );
  assert.equal(harness.records.at(-2)?.type, "user");
});

test("automatic compaction tries only once and keeps history when the summary is not smaller", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.0001;
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");
  harness.summaryText = "x".repeat(20_000);
  const summariesBefore = harness.calls.filter((call) => call.startsWith("summarize:")).length;
  const events: AutoCompactionEvent[] = [];

  const submitted = await harness.client.submitTurn("four", {
    onAutoCompaction: (event) => {
      events.push(event);
    },
  });

  assert.equal(submitted.result.status, "completed");
  assert.deepEqual(
    events.map((event) =>
      event.type === "skipped" ? `${event.type}:${event.reason}` : event.type,
    ),
    ["started", "skipped:not-smaller"],
  );
  assert.equal(
    harness.calls.filter((call) => call.startsWith("summarize:")).length - summariesBefore,
    1,
  );
  assert.equal(
    harness.records.some((event) => event.type === "compaction"),
    false,
  );
});

test("cancelling automatic compaction does not append the pending user message", async () => {
  const harness = createHarness();
  harness.contextSettings.autoCompact = true;
  harness.contextSettings.autoCompactThreshold = 0.0001;
  await harness.client.submitTurn("one");
  await harness.client.submitTurn("two");
  await harness.client.submitTurn("three");
  const recordsBefore = harness.records.length;
  const cancel = new AbortController();
  cancel.abort();

  const submitted = await harness.client.submitTurn("four", { signal: cancel.signal });

  assert.equal(submitted.result.status, "cancelled");
  assert.equal(harness.records.length, recordsBefore);
  assert.equal(
    harness.records.some((event) => event.type === "compaction"),
    false,
  );
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

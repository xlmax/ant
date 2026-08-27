import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  ModelRequestError,
  runAgent,
  type AgentEvent,
  type AgentModel,
} from "../packages/core/src/agent.js";
import { ToolEnvironment } from "../packages/tools-coding/src/tool-environment.js";
import { echoTool } from "./support/echo-tool.js";
import { StubModel } from "./support/stub-model.js";

test("the durable journal is written before UI observers run", async () => {
  const model: AgentModel = {
    async decide() {
      return { type: "finish", answer: "Готово" };
    },
  };
  const journal: AgentEvent[] = [];
  const state = createAgentState("Задача");

  await assert.rejects(
    runAgent(state, {
      model,
      environment: new ToolEnvironment([]),
      historyObserver: {
        onEvent: (event) => {
          journal.push(event);
        },
      },
      observers: [
        {
          onEvent: (event) => {
            if (event.type === "decision") throw new Error("UI boom");
          },
        },
      ],
    }),
    /UI boom/u,
  );

  // The journal and the in-memory state agree even though the UI observer
  // threw after the decision was recorded: persistence cannot run ahead of
  // memory.
  assert.equal(
    state.events.some((event) => event.type === "decision"),
    true,
  );
  assert.equal(
    journal.some((event) => event.type === "decision"),
    true,
  );
});

test("the model can call a tool and finish with its observation", async () => {
  const result = await runAgent(createAgentState("Привет"), {
    model: new StubModel(),
    environment: new ToolEnvironment([echoTool]),
  });

  assert.equal(result.status, "completed");

  if (result.status !== "completed") {
    return;
  }

  assert.equal(result.answer, 'Заглушка получила результат: {"text":"Привет"}');
  assert.deepEqual(
    result.state.events.map((event) => event.type),
    ["task", "decision", "observation", "decision"],
  );
});

test("the agent retries a retryable model request and records every attempt", async () => {
  let attempts = 0;
  const events: AgentEvent[] = [];
  const model: AgentModel = {
    async decide() {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelRequestError("Временная ошибка провайдера", true);
      }
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Проверь повтор"), {
    model,
    environment: new ToolEnvironment([]),
    observers: [
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
    ],
    modelMaxAttempts: 3,
    retryDelayMs: 0,
  });

  assert.equal(result.status, "completed");
  assert.equal(attempts, 2);
  assert.deepEqual(events, [
    { type: "model.requested", attempt: 1, maxAttempts: 3 },
    {
      type: "model.retry",
      reason: "Временная ошибка провайдера",
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 0,
    },
    { type: "model.requested", attempt: 2, maxAttempts: 3 },
    { type: "decision", decision: { type: "finish", answer: "Готово" } },
  ]);
});

test("the agent does not retry an unclassified TypeError", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async decide() {
      attempts += 1;
      throw new TypeError("Cannot read properties of undefined");
    },
  };

  await assert.rejects(
    runAgent(createAgentState("Проверь TypeError"), {
      model,
      environment: new ToolEnvironment([]),
      modelMaxAttempts: 3,
      retryDelayMs: 0,
    }),
    /Cannot read properties/u,
  );
  assert.equal(attempts, 1);
});

test("the agent retries a timed out model request", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async decide(_input, signal) {
      attempts += 1;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };

  await assert.rejects(
    runAgent(createAgentState("Проверь таймаут"), {
      model,
      environment: new ToolEnvironment([]),
      modelRequestTimeoutMs: 5,
      modelMaxAttempts: 2,
      retryDelayMs: 0,
    }),
    /Попытки исчерпаны \(2\/2\)/u,
  );
  assert.equal(attempts, 2);
});

test("the agent cancels immediately while waiting to retry", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const model: AgentModel = {
    async decide() {
      attempts += 1;
      throw new ModelRequestError("Временная ошибка провайдера", true);
    },
  };

  const result = await runAgent(createAgentState("Отмени повтор"), {
    model,
    environment: new ToolEnvironment([]),
    signal: controller.signal,
    modelMaxAttempts: 3,
    retryDelayMs: 10_000,
    observers: [
      {
        onEvent: (event) => {
          if (event.type === "model.retry") {
            controller.abort();
          }
        },
      },
    ],
  });

  assert.equal(result.status, "cancelled");
  assert.equal(attempts, 1);
});

test("the model request timeout resets while streaming reasoning", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async decide(_input, signal, _onTextDelta, onReasoningDelta) {
      attempts += 1;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
        signal?.throwIfAborted();
        onReasoningDelta?.(".");
      }
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Жди поток"), {
    model,
    environment: new ToolEnvironment([]),
    modelRequestTimeoutMs: 10,
    modelMaxAttempts: 2,
    onReasoningDelta: () => {},
  });

  assert.equal(result.status, "completed");
  assert.equal(attempts, 1);
});

test("the model request timeout resets on non-text stream activity", async () => {
  const model: AgentModel = {
    async decide(_input, signal, _text, _reasoning, _usage, onActivity) {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 4));
        signal?.throwIfAborted();
        onActivity?.();
      }
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Жди tool-call stream"), {
    model,
    environment: new ToolEnvironment([]),
    modelRequestTimeoutMs: 10,
    modelMaxAttempts: 1,
    onTextDelta: () => {},
  });
  assert.equal(result.status, "completed");
});

test("the agent does not retry after streaming has started", async () => {
  let attempts = 0;
  const model: AgentModel = {
    async decide(_input, _signal, onTextDelta) {
      attempts += 1;
      onTextDelta?.("Часть ответа");
      throw new ModelRequestError("Временная ошибка провайдера", true);
    },
  };

  await assert.rejects(
    runAgent(createAgentState("Проверь поток"), {
      model,
      environment: new ToolEnvironment([]),
      modelMaxAttempts: 3,
      retryDelayMs: 0,
      onTextDelta: () => {},
    }),
    /Текст ответа уже начал выводиться/u,
  );
  assert.equal(attempts, 1);
});

test("the agent executes every tool call from one model turn", async () => {
  const model: AgentModel = {
    async decide({ events }) {
      const observations = events.filter((event) => event.type === "observation");

      if (observations.length === 0) {
        return {
          type: "tools",
          calls: [
            {
              id: "batch-call-1",
              name: "echo",
              input: { text: "Первый" },
            },
            {
              id: "batch-call-2",
              name: "echo",
              input: { text: "Второй" },
            },
          ],
        };
      }

      return {
        type: "finish",
        answer: `Получено результатов: ${observations.length}`,
      };
    },
  };

  const result = await runAgent(createAgentState("Выполни два вызова"), {
    model,
    environment: new ToolEnvironment([echoTool]),
  });

  assert.equal(result.status, "completed");

  if (result.status !== "completed") {
    return;
  }

  assert.equal(result.answer, "Получено результатов: 2");
  assert.deepEqual(
    result.state.events.map((event) => event.type),
    ["task", "decision", "observation", "observation", "decision"],
  );
});

test("the environment executes parallel-safe tool calls concurrently", async () => {
  let active = 0;
  let maximumActive = 0;
  const tool = {
    metadata: {
      ownerId: "test.timing",
      sideEffects: "none" as const,
      parallelSafe: true,
      requiredCapabilities: [],
    },
    spec: { name: "delayed", description: "waits", inputSchema: { type: "object" } },
    async execute() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return "done";
    },
  };
  const environment = new ToolEnvironment([tool]);
  const observations = await environment.executeMany([
    { id: "one", name: "delayed", input: {} },
    { id: "two", name: "delayed", input: {} },
  ]);

  assert.equal(maximumActive, 2);
  assert.equal(observations.length, 2);
});

test("the environment keeps unsafe tool calls sequential", async () => {
  let active = 0;
  let maximumActive = 0;
  const tool = {
    metadata: {
      ownerId: "test.timing",
      sideEffects: "workspace" as const,
      parallelSafe: false,
      requiredCapabilities: [],
    },
    spec: { name: "mutating", description: "waits", inputSchema: { type: "object" } },
    async execute() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return "done";
    },
  };
  const environment = new ToolEnvironment([tool]);
  await environment.executeMany([
    { id: "one", name: "mutating", input: {} },
    { id: "two", name: "mutating", input: {} },
  ]);
  assert.equal(maximumActive, 1);
});

test("tool lifecycle and output events are observed but not added to model state", async () => {
  const lifecycleEvents: AgentEvent[] = [];
  const streamingTool = {
    metadata: {
      ownerId: "test.streaming",
      sideEffects: "process" as const,
      parallelSafe: false,
      requiredCapabilities: [],
    },
    spec: { name: "stream", description: "streams", inputSchema: { type: "object" } },
    async execute(_input: unknown, _signal?: AbortSignal, onOutput?: (output: never) => void) {
      onOutput?.({ stream: "stdout", content: "working\n" } as never);
      return { status: "done" };
    },
  };
  const model: AgentModel = {
    async decide({ events }) {
      return events.some((event) => event.type === "observation")
        ? { type: "finish", answer: "Готово" }
        : { type: "tools", calls: [{ id: "stream-1", name: "stream", input: {} }] };
    },
  };

  const result = await runAgent(createAgentState("Покажи поток"), {
    model,
    environment: new ToolEnvironment([streamingTool]),
    observers: [
      {
        onEvent: (event) => {
          lifecycleEvents.push(event);
        },
      },
    ],
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    lifecycleEvents.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.started", "tool.output", "tool.finished"],
  );
  assert.equal(
    result.state.events.some((event) => event.type.startsWith("tool.")),
    false,
  );
});

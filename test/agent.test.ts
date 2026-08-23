import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  ModelRequestError,
  runAgent,
  type AgentEvent,
  type AgentModel,
} from "../src/core/agent.js";
import { ToolEnvironment } from "../src/core/environment.js";
import { echoTool } from "./support/echo-tool.js";
import { StubModel } from "./support/stub-model.js";

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
    ["task", "model.requested", "decision", "observation", "model.requested", "decision"],
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
    [
      "task",
      "model.requested",
      "decision",
      "observation",
      "observation",
      "model.requested",
      "decision",
    ],
  );
});

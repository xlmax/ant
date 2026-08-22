import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  runAgent,
  type AgentModel,
} from "../src/agent.js";
import { echoTool } from "../src/echo-tool.js";
import { ToolEnvironment } from "../src/environment.js";
import { StubModel } from "../src/models/stub-model.js";

test("the model can call a tool and finish with its observation", async () => {
  const result = await runAgent(createAgentState("Привет"), {
    model: new StubModel(),
    environment: new ToolEnvironment([echoTool]),
  });

  assert.equal(result.status, "completed");

  if (result.status !== "completed") {
    return;
  }

  assert.equal(
    result.answer,
    'Заглушка получила результат: {"text":"Привет"}',
  );
  assert.deepEqual(
    result.state.events.map((event) => event.type),
    ["task", "decision", "observation", "decision"],
  );
});

test("the agent executes every tool call from one model turn", async () => {
  const model: AgentModel = {
    async decide({ events }) {
      const observations = events.filter(
        (event) => event.type === "observation",
      );

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

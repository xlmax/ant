import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  runAgent,
  type AgentModel,
  type ModelUsage,
} from "../packages/core/src/agent.js";
import { ToolEnvironment } from "../packages/tools-coding/src/tool-environment.js";

const reportedUsage: ModelUsage = {
  provider: "Test",
  model: "test-model",
  reasoning: "off",
  inputTokens: 240,
  outputTokens: 60,
  totalTokens: 300,
  contextWindow: 1_000,
  source: "provider",
};

test("the agent reports usage to observers as a transient lifecycle event", async () => {
  const received: ModelUsage[] = [];
  const model: AgentModel = {
    async decide(_input, _signal, _onTextDelta, _onReasoningDelta, onUsage) {
      onUsage?.(reportedUsage);
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Проверь usage"), {
    model,
    environment: new ToolEnvironment([]),
    observers: [
      {
        onEvent: (event) => {
          if (event.type === "model.usage") received.push(event.usage);
        },
      },
    ],
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(received, [reportedUsage]);
  // Usage is telemetry, not history: it never leaks into the persisted state.
  const historyTypes = ["task", "user", "decision", "compaction", "observation"];
  assert.ok(result.state.events.every((event) => historyTypes.includes(event.type)));
});

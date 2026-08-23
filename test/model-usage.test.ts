import assert from "node:assert/strict";
import test from "node:test";

import { createAgentState, runAgent, type AgentModel } from "../src/core/agent.js";
import { ToolEnvironment } from "../src/core/environment.js";

test("the agent persists usage reported by the model", async () => {
  const model: AgentModel = {
    async decide(_input, _signal, _onTextDelta, _onReasoningDelta, onUsage) {
      onUsage?.({
        provider: "Test",
        model: "test-model",
        reasoning: "off",
        inputTokens: 240,
        outputTokens: 60,
        totalTokens: 300,
        contextWindow: 1_000,
        source: "provider",
      });
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Проверь usage"), {
    model,
    environment: new ToolEnvironment([]),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.state.events.at(-2), {
    type: "model.usage",
    usage: {
      provider: "Test",
      model: "test-model",
      reasoning: "off",
      inputTokens: 240,
      outputTokens: 60,
      totalTokens: 300,
      contextWindow: 1_000,
      source: "provider",
    },
  });
});

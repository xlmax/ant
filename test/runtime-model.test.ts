import assert from "node:assert/strict";
import test from "node:test";

import type { ModelDescriptor } from "../packages/app/src/model-provider.js";
import { formatModelStatus } from "../packages/frontend-terminal/src/runtime-model.js";

const current: ModelDescriptor = {
  providerId: "deepseek",
  modelId: "deepseek-flash",
  contextWindow: 1_000_000,
  capabilities: {
    vision: true,
    reasoning: {
      supported: true,
      enabled: true,
      effort: "high",
      availableEfforts: ["low", "high", "max"],
    },
  },
};

test("runtime model status shows provider, model and reasoning mode", () => {
  assert.match(formatModelStatus(current), /deepseek\/deepseek-flash/u);
  assert.match(
    formatModelStatus({
      ...current,
      capabilities: {
        ...current.capabilities,
        reasoning: { ...current.capabilities.reasoning, enabled: false },
      },
    }),
    /thinking off/u,
  );
});

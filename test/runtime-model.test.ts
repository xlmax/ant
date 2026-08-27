import assert from "node:assert/strict";
import test from "node:test";

import type { ModelDescriptor } from "../src/app/model-provider.js";
import { formatModelStatus } from "../src/ui/runtime-model.js";

const current: ModelDescriptor = {
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  contextWindow: 1_000_000,
  capabilities: {
    vision: false,
    reasoning: {
      supported: true,
      enabled: true,
      effort: "high",
      availableEfforts: ["low", "high", "max"],
    },
  },
};

test("runtime model status shows provider, model and reasoning mode", () => {
  assert.match(formatModelStatus(current), /deepseek\/deepseek-v4-flash/u);
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

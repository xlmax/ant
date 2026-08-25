import assert from "node:assert/strict";
import test from "node:test";

import { modelSupportsVision } from "../src/core/model-capabilities.js";
import { selectModel } from "../src/ui/runtime-model.js";
import type { ModelSettings } from "../src/config/settings.js";

const baseSettings: ModelSettings = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  vision: false,
  thinking: { enabled: true, effort: "high" },
};

test("modelSupportsVision detects vision models by id", () => {
  assert.equal(modelSupportsVision("deepseek-v4-flash-vision-exp"), true);
  assert.equal(modelSupportsVision("deepseek-v4-flash"), false);
  assert.equal(modelSupportsVision("deepseek-vision-pro"), true);
});

test("selectModel syncs vision with the selected model id", () => {
  const visionModel = selectModel(baseSettings, "deepseek-v4-flash-vision-exp");
  assert.equal(visionModel.id, "deepseek-v4-flash-vision-exp");
  assert.equal(visionModel.vision, true);

  const textModel = selectModel(baseSettings, "deepseek-v4-flash");
  assert.equal(textModel.id, "deepseek-v4-flash");
  assert.equal(textModel.vision, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { ModelSettings } from "../src/config/settings.js";
import { formatModelStatus, selectEffort } from "../src/ui/runtime-model.js";

const current: ModelSettings = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  vision: false,
  thinking: { enabled: true, effort: "high" },
};

test("runtime effort selection enables thinking and supports turning it off", () => {
  assert.deepEqual(selectEffort(current, "max").thinking, {
    enabled: true,
    effort: "max",
  });
  assert.deepEqual(selectEffort(current, "off").thinking, {
    enabled: false,
    effort: "high",
  });
});

test("runtime model status shows provider, model and thinking mode", () => {
  assert.match(formatModelStatus(current), /deepseek\/deepseek-v4-flash/u);
  assert.match(formatModelStatus(selectEffort(current, "off")), /thinking off/u);
});

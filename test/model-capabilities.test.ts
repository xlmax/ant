import assert from "node:assert/strict";
import test from "node:test";

import { resolveVision } from "../src/config/settings.js";

test("resolveVision detects vision models by id as a fallback", () => {
  assert.equal(resolveVision("deepseek-v4-flash-vision-exp"), true);
  assert.equal(resolveVision("deepseek-v4-flash"), false);
  assert.equal(resolveVision("deepseek-vision-pro"), true);
});

test("resolveVision gives the explicit setting priority over the heuristic", () => {
  assert.equal(resolveVision("deepseek-v4-flash", false), false);
  assert.equal(resolveVision("deepseek-v4-flash", true), true);
  assert.equal(resolveVision("deepseek-vision-pro", false), false);
});

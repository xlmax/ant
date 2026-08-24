import assert from "node:assert/strict";
import test from "node:test";

import type { ModelSettings } from "../src/config/settings.js";
import { configureAnsi } from "../src/ui/ansi.js";
import { formatStartScreen } from "../src/ui/start-screen.js";

const settings: ModelSettings = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 1_000_000,
  vision: false,
  thinking: { enabled: true, effort: "high" },
};

test("start screen shows logo, version, model, location and commands", () => {
  configureAnsi(false);
  const screen = formatStartScreen({
    workspace: "C:\\Projects\\aiAgent",
    branch: "dev",
    modelSettings: settings,
  });

  assert.match(screen, /█████╗/u);
  assert.match(screen, /ant 0\.3\.0/u);
  assert.match(screen, /deepseek\/deepseek-v4-flash · thinking high/u);
  assert.match(screen, /C:\/Projects\/aiAgent · dev/u);
  assert.match(screen, /\/model/u);
  assert.match(screen, /\/exit/u);
});

test("start screen hides git branch when absent", () => {
  configureAnsi(false);
  const screen = formatStartScreen({
    workspace: "/home/user/project",
    branch: undefined,
    modelSettings: settings,
  });

  assert.match(screen, /\/home\/user\/project/u);
  assert.doesNotMatch(screen, / · dev/u);
});

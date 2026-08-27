import assert from "node:assert/strict";
import test from "node:test";

import type { ModelDescriptor } from "../packages/app/src/model-provider.js";
import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { formatStartScreen } from "../packages/frontend-terminal/src/start-screen.js";
import { VERSION } from "../packages/contracts/src/version.js";

const descriptor: ModelDescriptor = {
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

test("start screen shows logo, version, model, location and commands", () => {
  configureAnsi(false);
  const screen = formatStartScreen({
    workspace: "C:\\Projects\\aiAgent",
    branch: "dev",
    modelDescriptor: descriptor,
  });

  assert.match(screen, /█████╗/u);
  assert.ok(screen.includes(`Agentic Native Tool · v${VERSION}`));
  assert.match(screen, /● deepseek\/deepseek-v4-flash · think: high/u);
  assert.match(screen, /▸ C:\/Projects\/aiAgent/u);
  assert.match(screen, /└ dev/u);
  assert.match(screen, /\/model/u);
  assert.match(screen, /\/exit/u);
});

test("start screen hides git branch when absent", () => {
  configureAnsi(false);
  const screen = formatStartScreen({
    workspace: "/home/user/project",
    branch: undefined,
    modelDescriptor: descriptor,
  });

  assert.match(screen, /▸ \/home\/user\/project/u);
  assert.doesNotMatch(screen, /└ /u);
});

import assert from "node:assert/strict";
import test from "node:test";

import { ToolEnvironment } from "../src/core/environment.js";
import { createBashTool } from "../src/tools/bash-tool.js";

test("bash runs a command and returns its output", async () => {
  const environment = new ToolEnvironment([createBashTool(process.cwd())]);

  const observation = await environment.execute({
    id: "bash-call",
    name: "bash",
    input: { command: "printf 'hello\\n'" },
  });

  assert.deepEqual(observation, {
    ok: true,
    value: {
      exitCode: 0,
      output: "hello\n",
      truncated: false,
    },
  });
});

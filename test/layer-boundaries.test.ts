import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeWorkspaces } from "./support/workspace-analyzer.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("production source obeys the declared layer graph", async () => {
  assert.deepEqual(await analyzeWorkspaces(projectRoot), []);
});

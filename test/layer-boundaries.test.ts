import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeLayerBoundaries } from "./support/layer-analyzer.js";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

test("production source obeys the declared layer graph", async () => {
  assert.deepEqual(await analyzeLayerBoundaries(sourceRoot), []);
});

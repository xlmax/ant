import assert from "node:assert/strict";
import test from "node:test";

import { InputHistory } from "../packages/frontend-terminal/src/input-history.js";

test("input history navigates backward and restores the current draft", () => {
  const history = new InputHistory();
  history.add("первая задача");
  history.add("вторая задача");

  assert.equal(history.previous("черновик"), "вторая задача");
  assert.equal(history.previous("вторая задача"), "первая задача");
  assert.equal(history.next(), "вторая задача");
  assert.equal(history.next(), "черновик");
  assert.equal(history.isBrowsing, false);
});

test("input history does not store empty or consecutive duplicate entries", () => {
  const history = new InputHistory();
  history.add("");
  history.add("задача");
  history.add("задача");

  assert.equal(history.previous(""), "задача");
  assert.equal(history.previous("задача"), "задача");
});

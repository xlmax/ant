import assert from "node:assert/strict";
import test from "node:test";

import { cliHelp, parseCliOptions } from "../packages/cli/src/options.js";

test("short CLI keys select help, listing and session resume modes", () => {
  assert.deepEqual(parseCliOptions(["-h"]), {
    task: "",
    action: "help",
    continueLatest: false,
  });
  assert.deepEqual(parseCliOptions(["-r"]), {
    task: "",
    action: "list-sessions",
    continueLatest: false,
  });
  assert.deepEqual(parseCliOptions(["-v"]), {
    task: "",
    action: "version",
    continueLatest: false,
  });
  assert.deepEqual(parseCliOptions(["--version"]), {
    task: "",
    action: "version",
    continueLatest: false,
  });
  assert.deepEqual(parseCliOptions(["-c", "Продолжай"]), {
    task: "Продолжай",
    action: "run",
    continueLatest: true,
  });
  assert.deepEqual(parseCliOptions(["-s", "session-id", "Новая задача"]), {
    task: "Новая задача",
    action: "run",
    continueLatest: false,
    resume: "session-id",
  });
});

test("CLI keys reject invalid session selection combinations", () => {
  assert.throws(() => parseCliOptions(["-s"]), /Для -s нужно указать идентификатор сессии/u);
  assert.throws(
    () => parseCliOptions(["-c", "-s", "session-id"]),
    /только один способ выбрать сессию/u,
  );
  assert.throws(() => parseCliOptions(["-r", "Задача"]), /Ключ -r нельзя сочетать/u);
});

test("CLI help documents every short key", () => {
  const help = cliHelp();

  for (const key of ["-h", "-v", "-r", "-c", "-s <id>"]) {
    assert.ok(help.includes(key));
  }
});

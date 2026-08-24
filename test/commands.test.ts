import assert from "node:assert/strict";
import test from "node:test";

import { getReplCommands, parseReplCommand } from "../src/ui/commands.js";

test("command registry exposes the built-in help command", () => {
  assert.ok(getReplCommands().some((command) => command.name === "help"));
  assert.deepEqual(parseReplCommand("/help session"), {
    type: "help",
    command: {
      name: "session",
      usage: "/session",
      description: "Показать идентификатор и путь текущей сессии.",
    },
  });
});

test("reasoning command supports querying and changing its setting", () => {
  assert.deepEqual(parseReplCommand("/reasoning"), { type: "reasoning" });
  assert.deepEqual(parseReplCommand("/reasoning on"), {
    type: "reasoning",
    enabled: true,
  });
  assert.deepEqual(parseReplCommand("/reasoning off"), {
    type: "reasoning",
    enabled: false,
  });
});

test("context command accepts no arguments", () => {
  assert.deepEqual(parseReplCommand("/context"), { type: "context" });
  assert.deepEqual(parseReplCommand("/context extra"), {
    type: "error",
    message: "Использование: /context",
  });
});

test("model and think commands support querying and runtime selection", () => {
  assert.deepEqual(parseReplCommand("/model"), { type: "model" });
  assert.deepEqual(parseReplCommand("/think"), { type: "think" });
  assert.deepEqual(parseReplCommand("/model list"), {
    type: "model",
    list: true,
  });
  assert.deepEqual(parseReplCommand("/model deepseek-v4-pro"), {
    type: "model",
    id: "deepseek-v4-pro",
  });
  assert.deepEqual(parseReplCommand("/think max"), {
    type: "think",
    selection: "max",
  });
  assert.deepEqual(parseReplCommand("/think off"), {
    type: "think",
    selection: "off",
  });
  assert.deepEqual(parseReplCommand("/think fast"), {
    type: "error",
    message: "Использование: /think [off|low|high|max]",
  });
  assert.deepEqual(parseReplCommand("/model first second"), {
    type: "error",
    message: "Использование: /model [list|id]",
  });
  assert.deepEqual(parseReplCommand("/think low extra"), {
    type: "error",
    message: "Использование: /think [off|low|high|max]",
  });
});

test("command parser suggests a similar command", () => {
  assert.deepEqual(parseReplCommand("/sesion"), {
    type: "error",
    message: "Неизвестная команда: /sesion. Возможно, вы имели в виду /session.",
  });
});

test("plain and multiline user messages are not interpreted as commands", () => {
  assert.equal(parseReplCommand("Обычное сообщение"), undefined);
  assert.equal(parseReplCommand("/help\nЭто часть сообщения"), undefined);
});

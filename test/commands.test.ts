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

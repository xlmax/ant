import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandRegistry,
  CommandUsageError,
  type CommandContext,
} from "../src/ui/command-registry.js";
import { createBuiltinCommandRegistry } from "../src/ui/command-modules.js";

function invocation(registry: CommandRegistry, input: string): { name: string; input: unknown } {
  const parsed = registry.parse(input);
  assert.ok(parsed && !("error" in parsed));
  return { name: parsed.module.descriptor.name, input: parsed.input };
}

test("command registry exposes help and parses built-in command modules", () => {
  const registry = createBuiltinCommandRegistry();
  assert.ok(registry.descriptors.some((command) => command.name === "help"));
  assert.deepEqual(invocation(registry, "/reasoning on"), {
    name: "reasoning",
    input: { mode: "compact" },
  });
  assert.deepEqual(invocation(registry, "/model list"), {
    name: "model",
    input: { list: true },
  });
  assert.deepEqual(invocation(registry, "/think max"), {
    name: "think",
    input: { selection: "max" },
  });
});

test("command registry validates arguments and suggests a similar command", () => {
  const registry = createBuiltinCommandRegistry();
  assert.deepEqual(registry.parse("/context extra"), { error: "Использование: /context" });
  assert.deepEqual(registry.parse("/model first second"), {
    error: "Использование: /model [list|id]",
  });
  assert.deepEqual(registry.parse("/sesion"), {
    error: "Неизвестная команда: /sesion. Возможно, вы имели в виду /session.",
  });
  assert.equal(registry.parse("Обычное сообщение"), undefined);
  assert.equal(registry.parse("/help\nЭто часть сообщения"), undefined);
});

test("an independent command registers and runs without changing dispatch infrastructure", async () => {
  const registry = new CommandRegistry();
  const calls: string[] = [];
  registry.register({
    descriptor: { name: "ping", usage: "/ping value", description: "test" },
    parse(args) {
      if (args.length !== 1) throw new CommandUsageError("Использование: /ping value");
      return args[0]!;
    },
    handle(value) {
      calls.push(String(value));
      return "continue";
    },
  });
  const parsed = registry.parse("/ping pong");
  assert.ok(parsed && !("error" in parsed));
  await registry.dispatch(parsed, {} as CommandContext);
  assert.deepEqual(calls, ["pong"]);
  assert.throws(
    () =>
      registry.register({
        descriptor: { name: "ping", usage: "/ping", description: "duplicate" },
        parse() {},
        handle: () => "continue",
      }),
    /Duplicate command/u,
  );
});

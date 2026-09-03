import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import {
  CommandRegistry,
  CommandUsageError,
  type CommandContext,
} from "../packages/frontend-terminal/src/command-registry.js";
import { createBuiltinCommandRegistry } from "../packages/frontend-terminal/src/command-modules.js";
import { createBalanceCommand } from "../packages/cli/src/balance-command.js";
import { createKeyCommand } from "../packages/cli/src/credentials/key-command.js";
import type { DeepSeekCredentialManager } from "../packages/cli/src/credentials/deepseek-credentials.js";

test.afterEach(() => configureAnsi(true));

function invocation(registry: CommandRegistry, input: string): { name: string; input: unknown } {
  const parsed = registry.parse(input);
  assert.ok(parsed && !("error" in parsed));
  return { name: parsed.module.descriptor.name, input: parsed.input };
}

function createInteractiveRegistry(): CommandRegistry {
  const registry = createBuiltinCommandRegistry();
  const credentials = {
    status: async () => undefined,
    promptAndSave: async () => "cancelled" as const,
    clearStored: async () => false,
    hasEnvironmentKey: () => false,
  } as unknown as DeepSeekCredentialManager;
  registry.register(createKeyCommand(credentials));
  registry.register(
    createBalanceCommand(async () => ({
      available: true,
      balances: [
        {
          currency: "USD",
          totalBalance: "0.00",
          grantedBalance: "0.00",
          toppedUpBalance: "0.00",
        },
      ],
    })),
  );
  return registry;
}

test("command registry exposes help aliases and parses built-in command aliases", () => {
  const registry = createInteractiveRegistry();
  assert.ok(registry.descriptors.some((command) => command.name === "help"));
  assert.equal(registry.find("ctx")?.name, "context");
  assert.equal(registry.find("?")?.name, "help");
  assert.equal(registry.find("h")?.name, "help");
  assert.deepEqual(invocation(registry, "/?"), {
    name: "help",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/h"), {
    name: "help",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/n"), {
    name: "new",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/s"), {
    name: "session",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/c"), {
    name: "clear",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/ctx"), {
    name: "context",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/cmp"), {
    name: "compact",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/m list"), {
    name: "model",
    input: { list: true },
  });
  assert.deepEqual(invocation(registry, "/r full"), {
    name: "reasoning",
    input: { mode: "full" },
  });
  assert.deepEqual(invocation(registry, "/reasoning on"), {
    name: "reasoning",
    input: { mode: "compact" },
  });
  assert.deepEqual(invocation(registry, "/t off"), {
    name: "think",
    input: { selection: "off" },
  });
  assert.deepEqual(invocation(registry, "/u"), {
    name: "update",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/q"), {
    name: "exit",
    input: undefined,
  });
  assert.deepEqual(invocation(registry, "/k"), {
    name: "key",
    input: "status",
  });
  assert.deepEqual(invocation(registry, "/bal"), {
    name: "balance",
    input: undefined,
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

test("command registry validates arguments, lists aliases, and suggests a similar command", async () => {
  const registry = createInteractiveRegistry();
  configureAnsi(false);
  assert.deepEqual(registry.parse("/context extra"), { error: "Использование: /context" });
  assert.deepEqual(registry.parse("/model first second"), {
    error: "Использование: /model [list|id]",
  });
  assert.deepEqual(registry.parse("/qit"), {
    error: "Неизвестная команда: /qit. Возможно, вы имели в виду /exit.",
  });
  assert.deepEqual(registry.parse("/sesion"), {
    error: "Неизвестная команда: /sesion. Возможно, вы имели в виду /session.",
  });
  assert.equal(registry.parse("Обычное сообщение"), undefined);
  assert.equal(registry.parse("/help\nЭто часть сообщения"), undefined);

  const output: string[] = [];
  const parsed = registry.parse("/help");
  assert.ok(parsed && !("error" in parsed));
  await registry.dispatch(parsed, {
    terminal: { log: (message: string) => output.push(message) },
  } as unknown as CommandContext);
  const helpText = output.join("\n");
  assert.match(helpText, /\/help \(\?, h\) \[команда\]/u);
  assert.match(helpText, /\/context \(ctx\)/u);
  assert.match(helpText, /\/model \(m\)/u);
  assert.match(helpText, /\/balance \(bal\)/u);

  const modelHelp: string[] = [];
  const modelRequested = registry.parse("/help m");
  assert.ok(modelRequested && !("error" in modelRequested));
  await registry.dispatch(modelRequested, {
    terminal: { log: (message: string) => modelHelp.push(message) },
  } as unknown as CommandContext);
  assert.match(modelHelp.join("\n"), /^\/model \(m\) \[list\|id\]/u);
});

test("an independent command registers and runs without changing dispatch infrastructure", async () => {
  const registry = new CommandRegistry();
  const calls: string[] = [];
  registry.register({
    descriptor: { name: "ping", usage: "/ping value", description: "test", aliases: ["pong"] },
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
  assert.equal(registry.find("pong")?.name, "ping");
  assert.throws(
    () =>
      registry.register({
        descriptor: { name: "ping", usage: "/ping", description: "duplicate" },
        parse() {},
        handle: () => "continue",
      }),
    /Duplicate command/u,
  );
  assert.throws(
    () =>
      registry.register({
        descriptor: {
          name: "pang",
          usage: "/pang",
          description: "alias duplicate",
          aliases: ["pong"],
        },
        parse() {},
        handle: () => "continue",
      }),
    /Duplicate alias/u,
  );
  assert.throws(
    () =>
      registry.register({
        descriptor: { name: "pong", usage: "/pong", description: "name duplicate" },
        parse() {},
        handle: () => "continue",
      }),
    /Duplicate command/u,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { createBalanceCommand } from "../packages/cli/src/balance-command.js";
import type { CommandContext } from "../packages/frontend-terminal/src/command-registry.js";
import type {
  ProcessControl,
  TerminalPort,
} from "../packages/frontend-terminal/src/presentation-ports.js";
import { DeepSeekAccountClient } from "../packages/provider-deepseek/src/deepseek-account-client.js";

test("DeepSeek account client fetches and validates the current balance", async () => {
  const apiKey = "never-print-this";
  let request: { url: string; init?: RequestInit } | undefined;
  const client = new DeepSeekAccountClient({
    apiKey,
    async fetch(input, init) {
      request = init === undefined ? { url: String(input) } : { url: String(input), init };
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "12.34",
              granted_balance: "2.34",
              topped_up_balance: "10.00",
            },
          ],
        }),
      );
    },
  });

  assert.deepEqual(await client.getBalance(), {
    available: true,
    balances: [
      {
        currency: "USD",
        totalBalance: "12.34",
        grantedBalance: "2.34",
        toppedUpBalance: "10.00",
      },
    ],
  });
  assert.equal(request?.url, "https://api.deepseek.com/user/balance");
  assert.equal(
    (request?.init?.headers as Record<string, string>).Authorization,
    `Bearer ${apiKey}`,
  );
});

test("DeepSeek account client reports status and malformed responses without exposing the key", async () => {
  const apiKey = "never-print-this";
  const statusClient = new DeepSeekAccountClient({
    apiKey,
    fetch: async () => new Response("denied", { status: 401 }),
  });
  await assert.rejects(statusClient.getBalance(), (error: unknown) => {
    return (
      error instanceof Error && error.message.includes("401") && !error.message.includes(apiKey)
    );
  });

  const malformedClient = new DeepSeekAccountClient({
    apiKey,
    fetch: async () => new Response('{"is_available":true}'),
  });
  await assert.rejects(malformedClient.getBalance(), /invalid balance response/u);
});

test("balance command formats account balances and handles failures", async () => {
  const output: string[] = [];
  const terminal = {
    log: (message: string) => output.push(message),
    warn: (message: string) => output.push(message),
    error: (message: string) => output.push(message),
  } as unknown as TerminalPort;
  const process = {
    onInterrupt() {
      return () => {};
    },
  } as unknown as ProcessControl;
  const context = { terminal, process } as CommandContext;

  await createBalanceCommand(async () => ({
    available: true,
    balances: [
      {
        currency: "USD",
        totalBalance: "12.34",
        grantedBalance: "2.34",
        toppedUpBalance: "10.00",
      },
    ],
  })).handle(undefined, context);
  assert.match(output.join("\n"), /USD: 12\.34.*topped up: 10\.00.*granted: 2\.34/u);

  await createBalanceCommand(async () => {
    throw new Error("offline");
  }).handle(undefined, context);
  assert.match(output.at(-1) ?? "", /Не удалось получить баланс DeepSeek: offline/u);
});

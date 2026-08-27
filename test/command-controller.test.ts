import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../packages/app/src/session-controller.js";
import { MemorySessionStore } from "../packages/session-jsonl/src/memory-session-store.js";
import type { CommandContext } from "../packages/frontend-terminal/src/command-registry.js";
import { createBuiltinCommandRegistry } from "../packages/frontend-terminal/src/command-modules.js";

test("/exit prints a resume command only for an active session", async () => {
  const registry = createBuiltinCommandRegistry();
  const output: string[] = [];
  const sessions = new SessionController(new MemorySessionStore());
  const context = {
    options: { client: { activeSession: sessions.active } },
    terminal: { log: (message: string) => output.push(message) },
  } as unknown as CommandContext;
  const exit = registry.parse("/exit");
  assert.ok(exit && !("error" in exit));
  assert.equal(await registry.dispatch(exit, context), "exit");
  assert.equal(output.length, 0);

  await sessions.prepareUserMessage("Задача");
  const activeContext = {
    options: { client: { activeSession: sessions.active } },
    terminal: { log: (message: string) => output.push(message) },
  } as unknown as CommandContext;
  assert.equal(await registry.dispatch(exit, activeContext), "exit");
  assert.equal(output[0], `Для продолжения сессии: ant -s ${sessions.active?.session.id}`);
});

import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/app/session-controller.js";
import { handleReplCommand, type ReplCommandContext } from "../src/ui/command-controller.js";
import { MemorySessionStore } from "../src/sessions/memory-session-store.js";

function createSessions(): SessionController {
  return new SessionController(new MemorySessionStore());
}

test("/exit prints a resume command only for an active session", async () => {
  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]): void => {
    output.push(values.map(String).join(" "));
  };

  try {
    const emptySessions = createSessions();
    assert.equal(
      await handleReplCommand({ type: "exit" }, {
        options: { client: { activeSession: emptySessions.active } },
      } as unknown as ReplCommandContext),
      "exit",
    );
    assert.deepEqual(output, []);

    const activeSessions = createSessions();
    await activeSessions.prepareUserMessage("Задача");
    assert.equal(
      await handleReplCommand({ type: "exit" }, {
        options: { client: { activeSession: activeSessions.active } },
      } as unknown as ReplCommandContext),
      "exit",
    );
    assert.equal(output.length, 1);
    assert.equal(output[0], `Для продолжения сессии: ant -s ${activeSessions.active?.session.id}`);
  } finally {
    console.log = originalLog;
  }
});

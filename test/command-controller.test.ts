import assert from "node:assert/strict";
import test from "node:test";

import { SessionController } from "../src/app/session-controller.js";
import type { SessionStore } from "../src/app/session.js";
import { handleReplCommand, type ReplCommandContext } from "../src/ui/command-controller.js";

function createSessions(): SessionController {
  const store: SessionStore = {
    async create() {
      return {
        id: "session-42",
        observer: { onEvent: () => {} },
      };
    },
    async list() {
      return { sessions: [], warnings: [] };
    },
    async resume() {
      throw new Error("resume is not used in this test");
    },
  };
  return new SessionController(store);
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
    assert.match(output[0] ?? "", /Для продолжения сессии: ant -s session-42/u);
  } finally {
    console.log = originalLog;
  }
});

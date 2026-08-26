import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionController } from "../src/app/session-controller.js";
import { JsonlSessionStore } from "../src/sessions/jsonl-session-store.js";

test("session controller creates and appends user messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-controller-"));

  try {
    const controller = new SessionController(new JsonlSessionStore(directory));
    const first = await controller.prepareUserMessage("Первая задача");
    const second = await controller.prepareUserMessage("Продолжение");

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.state.events, [
      { type: "task", content: "Первая задача" },
      { type: "user", content: "Продолжение" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session controller resumes the active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-controller-"));

  try {
    const store = new JsonlSessionStore(directory);
    const original = new SessionController(store);
    const created = await original.prepareUserMessage("Сохранённая задача");
    await original.prepareUserMessage("Второй ход");

    const resumed = new SessionController(store);
    const active = await resumed.resume(created.session.id);

    assert.deepEqual(active.state.events, [
      { type: "task", content: "Сохранённая задача" },
      { type: "user", content: "Второй ход" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

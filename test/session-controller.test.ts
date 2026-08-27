import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionController } from "../packages/app/src/session-controller.js";
import type { SessionStore } from "../packages/app/src/session.js";
import { JsonlSessionStore } from "../packages/session-jsonl/src/jsonl-session-store.js";
import { MemorySessionStore } from "../packages/session-jsonl/src/memory-session-store.js";

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

test("session controller does not advance memory when append fails", async () => {
  const delegate = new MemorySessionStore();
  let rejectAppend = false;
  const store: SessionStore = {
    create: (input) => delegate.create(input),
    append: async (sessionId, payload) => {
      if (rejectAppend) throw new Error("storage unavailable");
      return delegate.append(sessionId, payload);
    },
    read: (sessionId) => delegate.read(sessionId),
    list: () => delegate.list(),
  };
  const controller = new SessionController(store);
  const created = await controller.prepareUserMessage("Задача");
  rejectAppend = true;

  await assert.rejects(controller.prepareUserMessage("Не сохранится"), /storage unavailable/u);
  assert.deepEqual(created.state.events, [{ type: "task", content: "Задача" }]);
});

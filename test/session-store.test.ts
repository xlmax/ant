import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeHistoryEvent, encodeHistoryEvent } from "../src/app/session-codec.js";
import type { SessionStore } from "../src/app/session.js";
import { JsonlSessionStore } from "../src/sessions/jsonl-session-store.js";
import { MemorySessionStore } from "../src/sessions/memory-session-store.js";

interface StoreFixture {
  store: SessionStore;
  cleanup(): Promise<void>;
}

type StoreFactory = () => Promise<StoreFixture>;

const memoryFactory: StoreFactory = async () => ({
  store: new MemorySessionStore(),
  async cleanup() {},
});

const jsonlFactory: StoreFactory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-contract-"));
  return {
    store: new JsonlSessionStore(directory),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

function sessionStoreContract(name: string, factory: StoreFactory): void {
  test(`${name}: create, append, read and list preserve opaque records`, async () => {
    const item = await factory();
    try {
      const initial = { kind: "example", nested: { value: 1 } };
      const session = await item.store.create({ task: "Contract task", payloads: [initial] });
      initial.nested.value = 99;
      const appended = { kind: "second", values: [1, 2] };
      const record = await item.store.append(session.id, appended);
      appended.values.push(3);

      const read = await item.store.read(session.id);
      assert.equal(read.session.id, session.id);
      assert.deepEqual(
        read.records.map((entry) => entry.payload),
        [
          { kind: "example", nested: { value: 1 } },
          { kind: "second", values: [1, 2] },
        ],
      );
      assert.ok(read.records.every((entry) => entry.schemaVersion === 2));
      assert.ok(read.records.every((entry) => entry.sessionId === session.id));
      assert.ok(read.records.every((entry) => !Number.isNaN(Date.parse(entry.timestamp))));
      assert.equal(record.sessionId, session.id);

      const listed = await item.store.list();
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.task, "Contract task");
      assert.deepEqual(listed.warnings, []);
    } finally {
      await item.cleanup();
    }
  });

  test(`${name}: sessions are isolated and unknown ids fail`, async () => {
    const item = await factory();
    try {
      const first = await item.store.create({ task: "First", payloads: [{ value: 1 }] });
      const second = await item.store.create({ task: "Second", payloads: [{ value: 2 }] });
      await item.store.append(first.id, { value: 3 });
      assert.equal((await item.store.read(first.id)).records.length, 2);
      assert.equal((await item.store.read(second.id)).records.length, 1);
      await assert.rejects(() => item.store.read("00000000-0000-0000-0000-000000000000"));
      await assert.rejects(() => item.store.append("00000000-0000-0000-0000-000000000000", {}));
    } finally {
      await item.cleanup();
    }
  });
}

sessionStoreContract("MemorySessionStore", memoryFactory);
sessionStoreContract("JsonlSessionStore", jsonlFactory);

test("JSONL writes version 2 envelopes and reads legacy version 1 journals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const current = await store.create({
      task: "Current",
      payloads: [encodeHistoryEvent({ type: "task", content: "Current" })!],
    });
    assert.match(await readFile(current.location!, "utf8"), /"schemaVersion":2/u);

    const legacyId = "00000000-0000-0000-0000-000000000001";
    const legacyPath = join(directory, `${legacyId}.jsonl`);
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        sessionId: legacyId,
        timestamp: "2026-01-01T00:00:00.000Z",
        event: { type: "task", content: "Legacy" },
      })}\n`,
      "utf8",
    );
    const legacy = await store.read(legacyId);
    assert.deepEqual(decodeHistoryEvent(legacy.records[0]?.payload), {
      type: "task",
      content: "Legacy",
    });
    await store.append(
      legacyId,
      encodeHistoryEvent({ type: "decision", decision: { type: "finish", answer: "ok" } })!,
    );
    const content = await readFile(legacyPath, "utf8");
    assert.match(content.split("\n")[0] ?? "", /"version":1/u);
    assert.match(content.split("\n")[1] ?? "", /"schemaVersion":2/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL repairs only a torn final JSON record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Task", payloads: [{ value: 1 }] });
    const path = session.location!;
    const valid = await readFile(path, "utf8");
    await writeFile(path, `${valid}{"schemaVersion":2`, "utf8");
    assert.equal((await store.read(session.id)).records.length, 1);
    assert.equal(await readFile(path, "utf8"), valid);

    const withoutNewline = valid.replace(/\n$/u, "");
    await writeFile(path, withoutNewline, "utf8");
    assert.equal((await store.read(session.id)).records.length, 1);
    assert.equal(await readFile(path, "utf8"), `${withoutNewline}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL rejects future envelope and payload versions without truncating", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Task", payloads: [{ value: 1 }] });
    const path = session.location!;
    const valid = await readFile(path, "utf8");
    const future = `${valid}${JSON.stringify({
      schemaVersion: 3,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      payload: {},
    })}`;
    await writeFile(path, future, "utf8");
    await assert.rejects(() => store.read(session.id), /строке 2/u);
    assert.equal(await readFile(path, "utf8"), future);

    const payload = encodeHistoryEvent({ type: "task", content: "Task" })!;
    (payload as { schemaVersion: number }).schemaVersion = 2;
    const other = await store.create({ task: "Payload", payloads: [payload] });
    const read = await store.read(other.id);
    assert.throws(() => decodeHistoryEvent(read.records[0]?.payload), /payload version.*2/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session codec excludes lifecycle events and preserves rich history payloads", () => {
  assert.equal(
    encodeHistoryEvent({ type: "model.requested", attempt: 1, maxAttempts: 1 }),
    undefined,
  );
  const event = {
    type: "observation" as const,
    call: { id: "image", name: "read", input: { path: "screen.png" } },
    observation: {
      ok: true as const,
      value: { kind: "image" },
      attachments: [
        {
          type: "image" as const,
          path: "attachment.png",
          mediaType: "image/png" as const,
          bytes: 12,
        },
      ],
    },
  };
  assert.deepEqual(decodeHistoryEvent(encodeHistoryEvent(event)), event);
});

test("JSONL list isolates a damaged session and rebuilds metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Healthy", payloads: [{ value: 1 }] });
    const brokenId = "00000000-0000-0000-0000-000000000002";
    await writeFile(join(directory, `${brokenId}.jsonl`), "\n{\n", "utf8");
    const listed = await store.list();
    assert.equal(listed.sessions[0]?.id, session.id);
    assert.equal(listed.warnings.length, 1);
    assert.match(listed.warnings[0] ?? "", new RegExp(brokenId, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeHistoryEvent, encodeHistoryEvent } from "../packages/app/src/session-codec.js";
import type { SessionStore } from "../packages/app/src/session.js";
import { JsonlSessionStore } from "../packages/session-jsonl/src/jsonl-session-store.js";
import { MemorySessionStore } from "../packages/session-jsonl/src/memory-session-store.js";

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

test("JSONL append repairs a torn tail without a preliminary full read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Task", payloads: [{ value: 1 }] });
    const path = session.location!;
    const valid = await readFile(path, "utf8");
    await writeFile(path, `${valid}{"schemaVersion":2`, "utf8");

    await store.append(session.id, { value: 2 });

    assert.deepEqual(
      (await store.read(session.id)).records.map((record) => record.payload),
      [{ value: 1 }, { value: 2 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL append does not create an unknown journal and accepts an existing empty one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const sessionId = "00000000-0000-0000-0000-000000000000";

    await assert.rejects(() => store.append(sessionId, { value: 1 }));
    assert.deepEqual(await readdir(directory), []);

    await writeFile(join(directory, `${sessionId}.jsonl`), "", "utf8");
    await store.append(sessionId, { value: 1 });
    assert.deepEqual(
      (await store.read(sessionId)).records.map((record) => record.payload),
      [{ value: 1 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL append preserves a large valid final record without a trailing newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const largeValue = "x".repeat(96 * 1024);
    const session = await store.create({ task: "Task", payloads: [{ largeValue }] });
    const path = session.location!;
    const withoutNewline = (await readFile(path, "utf8")).replace(/\n$/u, "");
    await writeFile(path, withoutNewline, "utf8");

    await store.append(session.id, { value: 2 });

    assert.deepEqual(
      (await store.read(session.id)).records.map((record) => record.payload),
      [{ largeValue }, { value: 2 }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL append parses only constant-size metadata, not every journal record", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({
      task: "Task",
      payloads: Array.from({ length: 1_000 }, (_, index) => ({ index })),
    });
    const parse = JSON.parse;
    let parseCalls = 0;
    context.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
      parseCalls += 1;
      return parse(...args);
    });

    await store.append(session.id, { value: "appended" });

    assert.equal(parseCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL preserves a session across many appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Task", payloads: [{ index: 0 }] });
    for (let index = 1; index <= 100; index += 1) {
      await store.append(session.id, { index });
    }

    const records = await store.read(session.id);
    assert.equal(records.records.length, 101);
    assert.deepEqual(records.records.at(-1)?.payload, { index: 100 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL serializes concurrent appends across store instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const firstStore = new JsonlSessionStore(directory);
    const secondStore = new JsonlSessionStore(directory);
    const session = await firstStore.create({ task: "Task", payloads: [{ index: -1 }] });
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 === 0 ? firstStore : secondStore).append(session.id, {
          index,
          padding: "x".repeat(index + 1),
        }),
      ),
    );

    const records = await firstStore.read(session.id);
    assert.equal(records.records.length, 51);
    assert.deepEqual(
      records.records
        .slice(1)
        .map((record) => (record.payload as { index: number }).index)
        .sort((left, right) => left - right),
      Array.from({ length: 50 }, (_, index) => index),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL repair does not race with concurrent appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Task", payloads: [{ index: -1 }] });
    const valid = await readFile(session.location!, "utf8");
    await writeFile(session.location!, `${valid}{"schemaVersion":2`, "utf8");

    await Promise.all([
      store.read(session.id),
      ...Array.from({ length: 20 }, (_, index) => store.append(session.id, { index })),
    ]);

    const records = await store.read(session.id);
    assert.equal(records.records.length, 21);
    assert.deepEqual(
      records.records
        .slice(1)
        .map((record) => (record.payload as { index: number }).index)
        .sort((left, right) => left - right),
      Array.from({ length: 20 }, (_, index) => index),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL append updates the metadata sidecar without rebuilding the journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Metadata task", payloads: [{ value: 1 }] });
    const record = await store.append(session.id, { value: 2 });
    const metadata = JSON.parse(
      await readFile(join(directory, `${session.id}.meta.json`), "utf8"),
    ) as Record<string, unknown>;

    assert.equal(metadata.updatedAt, record.timestamp);
    assert.equal(metadata.task, "Metadata task");
    assert.equal(metadata.fileSize, (await stat(session.location!)).size);
    assert.equal(metadata.modifiedAtMs, (await stat(session.location!)).mtimeMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL list rebuilds a missing metadata sidecar from the journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create({ task: "Recovered task", payloads: [{ value: 1 }] });
    const metadataPath = join(directory, `${session.id}.meta.json`);
    await rm(metadataPath);

    const listed = await store.list();

    assert.deepEqual(listed.warnings, []);
    assert.equal(listed.sessions[0]?.id, session.id);
    assert.equal(listed.sessions[0]?.task, "Recovered task");
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).id, session.id);
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentState, runAgent } from "../src/core/agent.js";
import { ToolEnvironment } from "../src/core/environment.js";
import { isPersistedEvent, JsonlSessionStore } from "../src/core/session-store.js";
import { echoTool } from "./support/echo-tool.js";
import { StubModel } from "./support/stub-model.js";

test("JSONL session store persists and resumes agent events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Исходная задача"));

    await session.observer.onEvent({
      type: "model.requested",
      attempt: 1,
      maxAttempts: 1,
    });
    await session.observer.onEvent({
      type: "model.usage",
      usage: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoning: "off",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        contextWindow: 1_000_000,
        source: "provider",
      },
    });
    await session.observer.onEvent({
      type: "decision",
      decision: {
        type: "finish",
        answer: "Первый ответ",
        reasoning: "Внутреннее рассуждение",
      },
    });

    const resumed = await store.resume(session.id);
    const content = await readFile(session.filePath, "utf8");

    assert.deepEqual(
      resumed.state.events.map((event) => event.type),
      ["task", "decision"],
    );
    assert.equal(content.trim().split("\n").length, 2);
    assert.match(content, /Внутреннее рассуждение/u);
    assert.match(content, /"version":1/u);
    assert.match(content, new RegExp(session.id, "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL session store lists saved sessions and their tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    assert.deepEqual(await store.list(), { sessions: [], warnings: [] });

    const first = await store.create(createAgentState("Первая задача"));
    const second = await store.create(createAgentState("Вторая задача"));
    const brokenId = "00000000-0000-0000-0000-000000000000";
    await writeFile(join(directory, `${brokenId}.jsonl`), "\n{\n", "utf8");
    const { sessions, warnings } = await store.list();
    const tasks = new Map(sessions.map((session) => [session.id, session.task]));

    assert.equal(sessions.length, 2);
    assert.equal(tasks.get(first.id), "Первая задача");
    assert.equal(tasks.get(second.id), "Вторая задача");
    assert.ok(sessions.every((session) => session.updatedAt.endsWith("Z")));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", new RegExp(brokenId, "u"));
    assert.match(warnings[0] ?? "", /строке 2/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL session store refreshes stale sidecar metadata from JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Задача из метаданных"));
    assert.equal((await store.list()).sessions[0]?.task, "Задача из метаданных");

    await writeFile(session.filePath, "{", "utf8");
    const listed = await store.list();

    assert.equal(listed.sessions.length, 0);
    assert.match(listed.warnings[0] ?? "", /некорректный JSON/u);
    await assert.rejects(store.resume(session.id), /некорректный JSON/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL session store ignores only an incomplete final record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Уцелевшая задача"));
    const validContent = await readFile(session.filePath, "utf8");
    await writeFile(session.filePath, `${validContent}{"version":1`, "utf8");

    const resumed = await store.resume(session.id);
    assert.deepEqual(resumed.state.events, [{ type: "task", content: "Уцелевшая задача" }]);

    // Resume must trim the partial tail so a later append keeps the journal
    // well-formed instead of concatenating JSON onto the damaged line.
    assert.equal(await readFile(session.filePath, "utf8"), validContent);

    await resumed.session.observer.onEvent({
      type: "decision",
      decision: { type: "finish", answer: "Дописанный ответ", reasoning: "" },
    });
    const afterAppend = await store.resume(session.id);
    assert.deepEqual(
      afterAppend.state.events.map((event) => event.type),
      ["task", "decision"],
    );
    assert.equal((await readFile(session.filePath, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL session store keeps a valid final record without a trailing newline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Уцелевшая задача"));
    const validContent = (await readFile(session.filePath, "utf8")).replace(/\n$/u, "");
    await writeFile(session.filePath, validContent, "utf8");

    // The single record is valid but lacks a trailing newline. Resume must not
    // treat it as a torn tail and truncate the file to zero.
    const resumed = await store.resume(session.id);
    assert.deepEqual(resumed.state.events, [{ type: "task", content: "Уцелевшая задача" }]);
    assert.equal(await readFile(session.filePath, "utf8"), `${validContent}\n`);

    await resumed.session.observer.onEvent({
      type: "decision",
      decision: { type: "finish", answer: "Дописанный ответ", reasoning: "" },
    });
    const afterAppend = await store.resume(session.id);
    assert.deepEqual(
      afterAppend.state.events.map((event) => event.type),
      ["task", "decision"],
    );
    assert.equal((await readFile(session.filePath, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JSONL session store preserves image attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Опиши изображение"));
    await session.observer.onEvent({
      type: "observation",
      call: { id: "read-image", name: "read", input: { path: "screen.png" } },
      observation: {
        ok: true,
        value: { kind: "image" },
        attachments: [
          {
            type: "image",
            path: "C:\\workspace\\.ant\\attachments\\hash.png",
            mediaType: "image/png",
            bytes: 12,
          },
        ],
      },
    });

    const resumed = await store.resume(session.id);
    assert.deepEqual(resumed.state.events.at(-1), {
      type: "observation",
      call: { id: "read-image", name: "read", input: { path: "screen.png" } },
      observation: {
        ok: true,
        value: { kind: "image" },
        attachments: [
          {
            type: "image",
            path: "C:\\workspace\\.ant\\attachments\\hash.png",
            mediaType: "image/png",
            bytes: 12,
          },
        ],
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session observer records the complete agent loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    const state = createAgentState("Поздоровайся");
    const session = await store.create(state);
    const result = await runAgent(state, {
      model: new StubModel(),
      environment: new ToolEnvironment([echoTool]),
      historyObserver: session.observer,
    });
    const resumed = await store.resume(session.id);

    assert.equal(result.status, "completed");
    const persistedEvents = result.state.events.filter((event) => isPersistedEvent(event));
    assert.deepEqual(resumed.state.events, persistedEvents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session journals do not persist transient tool lifecycle events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Поток"));
    const call = { id: "bash-1", name: "bash", input: { command: "work" } };
    await session.observer.onEvent({ type: "tool.started", call });
    await session.observer.onEvent({
      type: "tool.output",
      call,
      output: { stream: "stdout", content: "secret transient output" },
    });
    await session.observer.onEvent({
      type: "tool.finished",
      call,
      observation: { ok: true, value: { exitCode: 0 } },
      durationMs: 10,
    });

    const content = await readFile(session.filePath, "utf8");
    assert.doesNotMatch(content, /tool\.(started|output|finished)|secret transient output/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session journals persist compaction summaries and retained events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));
  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Старая задача"));
    const retainedEvents = [{ type: "user" as const, content: "Новая задача" }];
    await session.observer.onEvent({
      type: "compaction",
      summary: "Старая задача завершена.",
      retainedEvents,
    });

    const resumed = await store.resume(session.id);
    assert.deepEqual(resumed.state.events.at(-1), {
      type: "compaction",
      summary: "Старая задача завершена.",
      retainedEvents,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

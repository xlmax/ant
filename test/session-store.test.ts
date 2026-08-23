import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentState, runAgent } from "../src/core/agent.js";
import { ToolEnvironment } from "../src/core/environment.js";
import { JsonlSessionStore } from "../src/core/session-store.js";
import { echoTool } from "./support/echo-tool.js";
import { StubModel } from "./support/stub-model.js";

test("JSONL session store persists and resumes agent events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-session-"));

  try {
    const store = new JsonlSessionStore(directory);
    const session = await store.create(createAgentState("Исходная задача"));

    await session.observer.onEvent({ type: "model.requested" });
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
      ["task", "model.requested", "decision"],
    );
    assert.equal(content.trim().split("\n").length, 3);
    assert.match(content, /Внутреннее рассуждение/u);
    assert.match(content, /"version":1/u);
    assert.match(content, new RegExp(session.id, "u"));
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
        attachments: [{
          type: "image",
          path: "C:\\workspace\\.ant\\attachments\\hash.png",
          mediaType: "image/png",
          bytes: 12,
        }],
      },
    });

    const resumed = await store.resume(session.id);
    assert.deepEqual(resumed.state.events.at(-1), {
      type: "observation",
      call: { id: "read-image", name: "read", input: { path: "screen.png" } },
      observation: {
        ok: true,
        value: { kind: "image" },
        attachments: [{
          type: "image",
          path: "C:\\workspace\\.ant\\attachments\\hash.png",
          mediaType: "image/png",
          bytes: 12,
        }],
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
      observers: [session.observer],
    });
    const resumed = await store.resume(session.id);

    assert.equal(result.status, "completed");
    assert.deepEqual(resumed.state.events, result.state.events);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

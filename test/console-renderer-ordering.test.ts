import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleRenderer } from "../src/ui/console-renderer.js";

function createRenderer(writes: string[], showReasoning = false): ConsoleRenderer {
  return new ConsoleRenderer({
    showReasoning,
    write: (text) => writes.push(text),
    interactive: () => true,
  });
}

function stripAnsi(text: string): string {
  return text.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"), "");
}

test("reasoning and answer headers hide the cursor before buffered text arrives", async () => {
  const writes: string[] = [];
  const renderer = createRenderer(writes, true);
  try {
    renderer.beginTurn();
    renderer.onReasoningDelta("частичная строка");
    assert.ok(writes.join("").startsWith("\x1b[?25l"));
    assert.ok(!writes.join("").includes("\x1b[?25h"));
    await renderer.onEvent({ type: "decision", decision: { type: "finish", answer: "" } });
    await renderer.printResult({ status: "completed", answer: "", state: { events: [] } });

    writes.length = 0;
    renderer.beginTurn();
    renderer.onTextDelta("частичная строка");
    assert.ok(writes.join("").startsWith("\x1b[?25l"));
    assert.ok(!writes.join("").includes("\x1b[?25h"));
    await renderer.printResult({ status: "completed", answer: "", state: { events: [] } });
  } finally {
    renderer.dispose();
  }
});

test("tool rendering waits for reasoning without flushing its typing queue", async () => {
  const writes: string[] = [];
  const renderer = createRenderer(writes, true);
  try {
    renderer.beginTurn();
    const reasoning = `${"плавное рассуждение ".repeat(2)}\n`;
    renderer.onReasoningDelta(reasoning);
    await renderer.onEvent({
      type: "decision",
      decision: {
        type: "tools",
        calls: [{ id: "bash-1", name: "bash", input: { command: "npm test" } }],
      },
    });

    const call = { id: "bash-1", name: "bash", input: { command: "npm test" } };
    await renderer.onEvent({ type: "tool.started", call });
    await renderer.onEvent({
      type: "tool.finished",
      call,
      observation: {
        ok: true,
        value: { exitCode: 0, output: "", truncated: false },
      },
      durationMs: 250,
    });

    const rendered = stripAnsi(writes.join(""));
    assert.ok(rendered.indexOf("плавное рассуждение") < rendered.indexOf("→ bash npm test"));
    assert.match(rendered, /✓ bash exit 0 · 250 ms/u);

    const reasoningWrites = writes.filter((chunk) => /[а-я]/iu.test(stripAnsi(chunk)));
    assert.ok(reasoningWrites.length > 1, "reasoning must reach stdout over multiple timer ticks");
  } finally {
    renderer.dispose();
  }
});

test("cancellation while a tool waits for reasoning suppresses its UI", async () => {
  const writes: string[] = [];
  const renderer = createRenderer(writes, true);
  try {
    renderer.beginTurn();
    renderer.onReasoningDelta(`${"незавершённое рассуждение ".repeat(3)}\n`);
    await renderer.onEvent({
      type: "decision",
      decision: {
        type: "tools",
        calls: [{ id: "bash-1", name: "bash", input: { command: "npm test" } }],
      },
    });

    const started = renderer.onEvent({
      type: "tool.started",
      call: { id: "bash-1", name: "bash", input: { command: "npm test" } },
    });
    renderer.printCancellationPending();
    await started;

    const rendered = stripAnsi(writes.join(""));
    assert.doesNotMatch(rendered, /→ bash|⠋ bash/u);
    assert.match(rendered, /Отмена текущего хода/u);
  } finally {
    renderer.dispose();
  }
});

test("parallel tools keep the live line until the last tool finishes", async () => {
  const writes: string[] = [];
  const renderer = createRenderer(writes);
  const bash = { id: "bash-1", name: "bash", input: { command: "npm test" } };
  const read = { id: "read-1", name: "read", input: { path: "README.md" } };
  try {
    renderer.beginTurn();
    await renderer.onEvent({ type: "tool.started", call: bash });
    await renderer.onEvent({ type: "tool.started", call: read });
    await renderer.onEvent({
      type: "tool.finished",
      call: bash,
      observation: { ok: true, value: { exitCode: 0, output: "", truncated: false } },
      durationMs: 100,
    });

    const afterFirst = stripAnsi(writes.join(""));
    const firstResult = afterFirst.lastIndexOf("✓ bash exit 0 · 100 ms");
    assert.ok(firstResult >= 0);
    assert.match(afterFirst.slice(firstResult), /read ·/u);

    await renderer.onEvent({
      type: "tool.finished",
      call: read,
      observation: { ok: true, value: "README" },
      durationMs: 200,
    });
    assert.ok(writes.join("").endsWith("\x1b[?25h"));
  } finally {
    renderer.dispose();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleRenderer } from "../packages/frontend-terminal/src/console-renderer.js";
import { displayWidth } from "../packages/frontend-terminal/src/display-width.js";

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

test("turn shows an immediate status until the model starts responding", async () => {
  const writes: string[] = [];
  const renderer = createRenderer(writes);
  try {
    renderer.beginTurn();
    assert.match(stripAnsi(writes.join("")), /⠋ Подготовка запроса · \d+ ms/u);

    renderer.printNotice("Сессия: test-session");
    const noticeOutput = writes.join("");
    const clearLine = `\r${String.fromCharCode(27)}[2K`;
    const sessionBoundary = `${clearLine}Сессия: test-session\n${clearLine}`;
    assert.ok(noticeOutput.includes(sessionBoundary));
    assert.ok(
      noticeOutput.lastIndexOf("Подготовка запроса") > noticeOutput.indexOf(sessionBoundary),
    );

    await renderer.onEvent({ type: "model.requested", attempt: 1, maxAttempts: 3 });
    assert.match(stripAnsi(writes.join("")), /Ожидание модели · попытка 1\/3/u);

    await renderer.onEvent({
      type: "model.retry",
      reason: "таймаут",
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
    });
    const retryOutput = stripAnsi(writes.join(""));
    assert.match(retryOutput, /⚠ Повтор запроса к модели: таймаут/u);
    assert.match(retryOutput, /Ожидание повтора/u);

    await renderer.onEvent({ type: "model.requested", attempt: 2, maxAttempts: 3 });
    renderer.onTextDelta("Ответ");
    const rendered = writes.join("");
    assert.match(stripAnsi(rendered), /Ожидание модели · попытка 2\/3/u);
    assert.ok(rendered.lastIndexOf("\r\x1b[2K") < rendered.lastIndexOf("───"));
  } finally {
    renderer.dispose();
  }
});

test("live status stays on one row in a narrow terminal", async () => {
  const writes: string[] = [];
  const renderer = new ConsoleRenderer({
    write: (text) => writes.push(text),
    interactive: () => true,
    width: () => 24,
  });
  try {
    renderer.beginTurn();
    await renderer.onEvent({ type: "model.requested", attempt: 1, maxAttempts: 3 });

    const statusWrites = writes
      .map(stripAnsi)
      .map((text) => text.replace(/^\r/u, ""))
      .filter((text) => text !== "");
    assert.ok(statusWrites.some((text) => text.includes("Модель 1/3")));
    assert.ok(statusWrites.every((text) => !text.includes("\n") && displayWidth(text) <= 23));
  } finally {
    renderer.dispose();
  }
});

test("redirected output does not contain transient request status", async () => {
  const writes: string[] = [];
  const renderer = new ConsoleRenderer({
    write: (text) => writes.push(text),
    interactive: () => false,
  });
  try {
    renderer.beginTurn();
    await renderer.onEvent({ type: "model.requested", attempt: 1, maxAttempts: 1 });
    assert.equal(writes.join(""), "");
  } finally {
    renderer.dispose();
  }
});

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

test("compact reasoning uses a scrolling viewport before the next stream block", async () => {
  const writes: string[] = [];
  const renderer = new ConsoleRenderer({
    reasoningMode: "compact",
    reasoningMaxLines: 2,
    write: (text) => writes.push(text),
    interactive: () => true,
  });
  try {
    renderer.beginTurn();
    renderer.onReasoningDelta("первая строка\nвторая строка\nтретья строка\n");
    await renderer.onEvent({
      type: "decision",
      decision: {
        type: "tools",
        calls: [{ id: "read-1", name: "read", input: { path: "README.md" } }],
      },
    });
    const call = { id: "read-1", name: "read", input: { path: "README.md" } };
    await renderer.onEvent({ type: "tool.started", call });
    await renderer.onEvent({
      type: "tool.finished",
      call,
      observation: { ok: true, value: "README" },
      durationMs: 100,
    });

    const rendered = writes.join("");
    assert.ok(rendered.includes(`${String.fromCharCode(27)}[2A`));
    assert.ok(rendered.lastIndexOf("третья строка") < rendered.lastIndexOf("→ read README.md"));
    assert.doesNotMatch(stripAnsi(rendered), /`|\*\*/u);
  } finally {
    renderer.dispose();
  }
});

test("compact mode falls back to full untruncated reasoning outside a TTY", async () => {
  const writes: string[] = [];
  const renderer = new ConsoleRenderer({
    reasoningMode: "compact",
    reasoningMaxLines: 2,
    write: (text) => writes.push(text),
    interactive: () => false,
  });
  try {
    renderer.beginTurn();
    renderer.onReasoningDelta(
      "| key | value |\n| --- | --- |\n| command | a very long value that must remain complete in redirected output |\n",
    );
    await renderer.onEvent({ type: "decision", decision: { type: "finish", answer: "ok" } });
    await renderer.printResult({ status: "completed", answer: "ok", state: { events: [] } });

    const rendered = stripAnsi(writes.join(""));
    assert.match(rendered, /a very long value that must remain complete in redirected output/u);
    assert.ok(!writes.join("").includes(`${String.fromCharCode(27)}[`));
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

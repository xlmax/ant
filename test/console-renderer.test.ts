import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { ConsoleRenderer } from "../packages/frontend-terminal/src/console-renderer.js";

test("reasoning output uses muted markdown formatting", async () => {
  const originalWrite = process.stdout.write;
  const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const output: string[] = [];

  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(true);

  try {
    const renderer = new ConsoleRenderer({ showReasoning: true });
    renderer.beginTurn();
    renderer.onReasoningDelta("**важно** и `code`\n");
    await renderer.onEvent({ type: "decision", decision: { type: "finish", answer: "" } });
    await renderer.printResult({ status: "completed", answer: "", state: { events: [] } });
    renderer.beginTurn();
    await renderer.onEvent({
      type: "decision",
      decision: { type: "finish", answer: "", reasoning: "*отдельный блок*" },
    });
    await renderer.printResult({ status: "completed", answer: "", state: { events: [] } });

    const rendered = output.join("");
    const plain = rendered.replaceAll(
      new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"),
      "",
    );
    assert.match(plain, /важно и code/u);
    assert.match(plain, /отдельный блок/u);
    assert.doesNotMatch(plain, /Рассуждения|\*\*|`/u);
    assert.match(rendered, new RegExp(`${String.fromCharCode(27)}\\[2m`, "u"));
  } finally {
    process.stdout.write = originalWrite;
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    configureAnsi(true);
  }
});

test("Ant and change summaries color their full boundaries", async () => {
  const originalWrite = process.stdout.write;
  const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const output: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(true);

  try {
    const renderer = new ConsoleRenderer();
    renderer.beginTurn();
    await renderer.printResult({
      status: "completed",
      answer: "Готово",
      state: { events: [] },
    });
    await renderer.printChangeSummary({
      commands: ["npm test"],
      changedFiles: [{ path: "src/ui/console-renderer.ts", status: "M " }],
      toolWrittenFiles: [],
      gitAvailable: true,
      baselineDirty: false,
    });

    const rendered = output.join("");
    const plain = rendered.replaceAll(
      new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"),
      "",
    );
    assert.match(plain, /^───Ant─/mu);
    assert.match(plain, /^───Изменения─/mu);
    assert.doesNotMatch(plain, /Агент/u);
    assert.ok(rendered.includes(`${String.fromCharCode(27)}[32m───`));
    assert.ok(rendered.includes(`${String.fromCharCode(27)}[38;2;197;140;106m───`));
  } finally {
    process.stdout.write = originalWrite;
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    configureAnsi(true);
  }
});

test("empty reasoning does not render an empty block", async () => {
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(false);

  try {
    const renderer = new ConsoleRenderer({ showReasoning: true });
    renderer.beginTurn();
    renderer.onReasoningDelta("   \n");
    await renderer.onEvent({
      type: "decision",
      decision: { type: "finish", answer: "ok", reasoning: "   " },
    });
    const rendered = output.join("");
    assert.doesNotMatch(rendered, /───/u);
  } finally {
    process.stdout.write = originalWrite;
    configureAnsi(true);
  }
});

test("tool output is separated from the agent answer by a blank line", async () => {
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(false);

  try {
    const renderer = new ConsoleRenderer();
    renderer.beginTurn();
    const call = { id: "bash-1", name: "bash", input: { command: "build" } };
    await renderer.onEvent({ type: "tool.started", call });
    await renderer.onEvent({
      type: "tool.finished",
      call,
      observation: {
        ok: true as const,
        value: { exitCode: 0, output: "built\n", truncated: false },
      },
      durationMs: 100,
    });
    renderer.onTextDelta("Готово");

    const rendered = output.join("");
    assert.match(rendered, /✓ bash exit 0 · 100 ms\n\n───Ant/u);
  } finally {
    process.stdout.write = originalWrite;
    configureAnsi(true);
  }
});

test("tool output is not streamed and the final observation is not duplicated", async () => {
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(false);

  try {
    const renderer = new ConsoleRenderer();
    renderer.beginTurn();
    const call = { id: "bash-1", name: "bash", input: { command: "build" } };
    await renderer.onEvent({ type: "tool.started", call });
    await renderer.onEvent({
      type: "tool.output",
      call,
      output: { stream: "stdout", content: "building\n" },
    });
    const observation = {
      ok: true as const,
      value: { exitCode: 0, output: "building\n", truncated: false },
    };
    await renderer.onEvent({
      type: "tool.finished",
      call,
      observation,
      durationMs: 120,
    });
    await renderer.onEvent({ type: "observation", call, observation });

    const rendered = output.join("");
    assert.match(rendered, /→ bash build/u);
    assert.doesNotMatch(rendered, /building/u);
    assert.match(rendered, /✓ bash exit 0 · 120 ms/u);
    assert.equal(rendered.match(/exit 0/gu)?.length, 1);
  } finally {
    process.stdout.write = originalWrite;
    configureAnsi(true);
  }
});

test("interactive tool rendering shows a spinner line instead of streaming output", async () => {
  const originalWrite = process.stdout.write;
  const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const output: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(false);

  try {
    const renderer = new ConsoleRenderer();
    renderer.beginTurn();
    const call = { id: "bash-1", name: "bash", input: { command: "npm test" } };
    await renderer.onEvent({ type: "tool.started", call });
    await renderer.onEvent({
      type: "tool.output",
      call,
      output: { stream: "stdout", content: "running tests\n" },
    });
    await renderer.onEvent({
      type: "tool.finished",
      call,
      observation: {
        ok: true as const,
        value: { exitCode: 0, output: "running tests\n", truncated: false },
      },
      durationMs: 3500,
    });

    const rendered = output.join("");
    assert.match(rendered, /→ bash npm test/u);
    assert.ok(rendered.includes(`\r${String.fromCharCode(27)}[2K`));
    assert.doesNotMatch(rendered, /running tests/u);
    assert.match(rendered, /✓ bash exit 0 · 3\.5 s/u);
  } finally {
    process.stdout.write = originalWrite;
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    configureAnsi(true);
  }
});

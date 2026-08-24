import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../src/ui/ansi.js";
import { ConsoleRenderer } from "../src/ui/console-renderer.js";

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
    renderer.beginTurn();
    await renderer.onEvent({
      type: "decision",
      decision: { type: "finish", answer: "", reasoning: "*отдельный блок*" },
    });

    const rendered = output.join("");
    const plain = rendered.replaceAll(
      new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu"),
      "",
    );
    assert.match(plain, /важно и code/u);
    assert.match(plain, /отдельный блок/u);
    assert.doesNotMatch(plain, /\*\*|`/u);
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

test("tool output is rendered live and the final observation is not duplicated", async () => {
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
    assert.match(rendered, /→ bash/u);
    assert.match(rendered, /building/u);
    assert.match(rendered, /exit 0/u);
    assert.equal(rendered.match(/building/gu)?.length, 1);
  } finally {
    process.stdout.write = originalWrite;
    configureAnsi(true);
  }
});

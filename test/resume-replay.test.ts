import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { formatResumeReplay } from "../packages/frontend-terminal/src/resume-replay.js";
import { sectionFooter } from "../packages/frontend-terminal/src/section.js";
import type { HistoryEvent } from "../packages/core/src/agent.js";

function withAnsiDisabled<T>(fn: () => T): T {
  configureAnsi(false);
  try {
    return fn();
  } finally {
    configureAnsi(true);
  }
}

test("resume replay renders a completed turn without raw tool payloads", () => {
  const events: HistoryEvent[] = [
    { type: "task", content: "Собери отчёт" },
    {
      type: "decision",
      decision: {
        type: "tools",
        reasoning: "Сначала проверяю файл.",
        calls: [{ id: "read-1", name: "read", input: { path: "src/app.ts" } }],
      },
    },
    {
      type: "observation",
      call: { id: "read-1", name: "read", input: { path: "src/app.ts" } },
      observation: { ok: true, value: { stdout: "SECRET-RAW" } },
    },
    {
      type: "decision",
      decision: {
        type: "finish",
        reasoning: "Готово.",
        answer: ["line-00", "line-01", "line-02", "line-03", "line-04"].join("\n"),
      },
    },
  ];

  const output = withAnsiDisabled(() =>
    formatResumeReplay(events, { reasoningMode: "full", reasoningMaxLines: 3 }),
  );

  assert.match(output, /Собери отчёт/u);
  assert.match(output, /Сначала проверяю файл\./u);
  assert.match(output, /→ read src\/app\.ts/u);
  assert.match(output, /✓ read/u);
  assert.match(output, /line-00/u);
  assert.match(output, /line-04/u);
  assert.doesNotMatch(output, /SECRET-RAW/u);
});

test("resume replay renders the user block with a violet frame and raw continuations", () => {
  const output = withAnsiDisabled(() =>
    formatResumeReplay(
      [
        { type: "user", content: "Первая строка\nВторая строка\nТретья строка" },
        {
          type: "decision",
          decision: { type: "finish", answer: "Ок" },
        },
      ],
      { reasoningMode: "off", reasoningMaxLines: 3 },
    ),
  );

  const lines = output.trimEnd().split("\n");
  const frame = sectionFooter();

  assert.equal(lines[0], frame);
  assert.equal(lines[1], "› Первая строка");
  assert.equal(lines[2], "Вторая строка");
  assert.equal(lines[3], "Третья строка");
  assert.equal(lines[4], frame);
  assert.equal(output.includes("\n  Вторая строка"), false);
  assert.equal(output.includes("\n  Третья строка"), false);
});

test("resume replay renders a single-line user block inside a violet frame", () => {
  const output = withAnsiDisabled(() =>
    formatResumeReplay(
      [
        { type: "task", content: "Сделай это" },
        {
          type: "decision",
          decision: { type: "finish", answer: "Ок" },
        },
      ],
      { reasoningMode: "off", reasoningMaxLines: 3 },
    ),
  );

  const lines = output.trimEnd().split("\n");
  const frame = sectionFooter();

  assert.equal(lines[0], frame);
  assert.equal(lines[1], "› Сделай это");
  assert.equal(lines[2], frame);
});

test("resume replay tolerates empty user content", () => {
  const output = withAnsiDisabled(() =>
    formatResumeReplay(
      [
        { type: "user", content: "" },
        {
          type: "decision",
          decision: { type: "finish", answer: "Ок" },
        },
      ],
      { reasoningMode: "off", reasoningMaxLines: 3 },
    ),
  );

  const lines = output.trimEnd().split("\n");
  const frame = sectionFooter();

  assert.equal(lines[0], frame);
  assert.equal(lines[1], "› ");
  assert.equal(lines[2], frame);
});

test("resume replay marks interrupted turns", () => {
  const events: HistoryEvent[] = [
    { type: "user", content: "Проверь" },
    {
      type: "decision",
      decision: {
        type: "tools",
        reasoning: "Нужна диагностика.",
        calls: [{ id: "bash-1", name: "bash", input: { command: "cat /tmp/x" } }],
      },
    },
    {
      type: "observation",
      call: { id: "bash-1", name: "bash", input: { command: "cat /tmp/x" } },
      observation: { ok: false, error: "boom" },
    },
  ];

  const output = withAnsiDisabled(() =>
    formatResumeReplay(events, { reasoningMode: "full", reasoningMaxLines: 3 }),
  );

  assert.match(output, /Проверь/u);
  assert.match(output, /Нужна диагностика\./u);
  assert.match(output, /→ bash cat \/tmp\/x/u);
  assert.match(output, /✗ bash — boom/u);
  assert.match(output, /Ход был прерван/u);
});

test("resume replay respects reasoning display mode and line limits", () => {
  const events: HistoryEvent[] = [
    { type: "task", content: "Задача" },
    {
      type: "decision",
      decision: {
        type: "tools",
        reasoning: ["r1", "r2", "r3", "r4"].join("\n"),
        calls: [{ id: "read-1", name: "read", input: { path: "src/lib.ts" } }],
      },
    },
    {
      type: "observation",
      call: { id: "read-1", name: "read", input: { path: "src/lib.ts" } },
      observation: { ok: true, value: { stdout: "SECRET-RAW" } },
    },
    {
      type: "decision",
      decision: {
        type: "finish",
        reasoning: "SECRET-REASON",
        answer: "Готово",
      },
    },
  ];

  const off = withAnsiDisabled(() =>
    formatResumeReplay(events, { reasoningMode: "off", reasoningMaxLines: 2 }),
  );
  assert.doesNotMatch(off, /\br1\b/u);
  assert.doesNotMatch(off, /\bSECRET-REASON\b/u);
  assert.doesNotMatch(off, /\bSECRET-RAW\b/u);
  assert.match(off, /Готово/u);

  const full = withAnsiDisabled(() =>
    formatResumeReplay(events, { reasoningMode: "full", reasoningMaxLines: 2 }),
  );
  assert.match(full, /\br1\b/u);
  assert.match(full, /\br4\b/u);

  const compact = withAnsiDisabled(() =>
    formatResumeReplay(events, { reasoningMode: "compact", reasoningMaxLines: 2 }),
  );
  assert.doesNotMatch(compact, /\br1\b/u);
  assert.doesNotMatch(compact, /\br2\b/u);
  assert.match(compact, /\br3\b/u);
  assert.match(compact, /\br4\b/u);
});

test("resume replay shows a neutral message when history is empty", () => {
  const output = withAnsiDisabled(() =>
    formatResumeReplay([], { reasoningMode: "full", reasoningMaxLines: 2 }),
  );

  assert.match(output, /Нет истории для показа/u);
});

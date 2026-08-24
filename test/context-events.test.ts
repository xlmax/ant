import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../src/core/agent.js";
import { activeContextEvents, createCompactionPlan } from "../src/core/context-events.js";

function finish(answer: string): AgentEvent {
  return { type: "decision", decision: { type: "finish", answer } };
}

test("compaction plan summarizes old events and retains the last two user turns", () => {
  const events: AgentEvent[] = [
    { type: "task", content: "Первый ход" },
    finish("Первый ответ"),
    { type: "user", content: "Второй ход" },
    finish("Второй ответ"),
    { type: "user", content: "Третий ход" },
    finish("Третий ответ"),
  ];
  const plan = createCompactionPlan(events);

  assert.ok(plan);
  assert.deepEqual(plan.eventsToSummarize, events.slice(0, 2));
  assert.deepEqual(plan.retainedEvents, events.slice(2));
  assert.equal(plan.retainedUserTurns, 2);
});

test("active context uses the latest summary without deleting retained events", () => {
  const retained: AgentEvent[] = [
    { type: "user", content: "Второй ход" },
    finish("Второй ответ"),
    { type: "user", content: "Третий ход" },
    finish("Третий ответ"),
  ];
  const events: AgentEvent[] = [
    { type: "task", content: "Первый ход" },
    finish("Первый ответ"),
    ...retained,
    { type: "compaction", summary: "Первый ход завершён.", retainedEvents: retained },
    { type: "user", content: "Четвёртый ход" },
  ];

  assert.deepEqual(activeContextEvents(events), [
    { type: "compaction", summary: "Первый ход завершён.", retainedEvents: retained },
    ...retained,
    { type: "user", content: "Четвёртый ход" },
  ]);
  assert.equal(
    activeContextEvents(events).some((event) => event.type === "task"),
    false,
  );
});

test("a later compaction flattens the previous summary and retained history", () => {
  const retained: AgentEvent[] = [
    { type: "user", content: "Второй ход" },
    finish("Второй ответ"),
    { type: "user", content: "Третий ход" },
    finish("Третий ответ"),
  ];
  const events: AgentEvent[] = [
    { type: "compaction", summary: "Первый ход завершён.", retainedEvents: retained },
    { type: "user", content: "Четвёртый ход" },
    finish("Четвёртый ответ"),
  ];
  const plan = createCompactionPlan(events);

  assert.ok(plan);
  assert.deepEqual(plan.retainedEvents, [
    { type: "user", content: "Третий ход" },
    finish("Третий ответ"),
    { type: "user", content: "Четвёртый ход" },
    finish("Четвёртый ответ"),
  ]);
  assert.equal(plan.eventsToSummarize[0]?.type, "task");
  assert.match(
    plan.eventsToSummarize[0]?.type === "task" ? plan.eventsToSummarize[0].content : "",
    /Первый ход завершён/u,
  );
});

test("compaction plan requires more turns than it retains", () => {
  assert.equal(
    createCompactionPlan([
      { type: "task", content: "Первый" },
      finish("Ответ"),
      { type: "user", content: "Второй" },
    ]),
    undefined,
  );
});

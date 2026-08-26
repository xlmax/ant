import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  runAgent,
  verifyTurn,
  type AgentModel,
  type HistoryEvent,
  type VerificationSettings,
} from "../src/core/agent.js";
import { ToolEnvironment } from "../src/core/environment.js";

const allChecks: VerificationSettings = {
  enabled: true,
  maxRounds: 2,
  checks: ["empty-answer", "echo-task", "failed-tools"],
};

function baseEvents(): HistoryEvent[] {
  return [{ type: "task", content: "Прочитай README и перескажи" }];
}

test("verifyTurn passes a substantive non-echo answer with no tool failures", () => {
  const outcome = verifyTurn(
    {
      answer: "В README описаны инструменты и запуск через npm run dev.",
      events: baseEvents(),
      turnStartIndex: 1,
    },
    allChecks,
  );

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.issues, []);
});

test("verifyTurn fails an empty answer", () => {
  const outcome = verifyTurn(
    { answer: "   \n ", events: baseEvents(), turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.issues[0]?.code, "empty-answer");
  assert.match(outcome.feedback, /пустым ответом/u);
});

test("verifyTurn fails an answer that just echoes the task", () => {
  const outcome = verifyTurn(
    { answer: "Прочитай README и перескажи", events: baseEvents(), turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, false);
  assert.deepEqual(
    outcome.issues.map((issue) => issue.code),
    ["echo-task"],
  );
});

test("verifyTurn fails an unacknowledged tool failure from the current turn", () => {
  const events: HistoryEvent[] = [
    ...baseEvents(),
    {
      type: "observation",
      call: { id: "r-1", name: "read", input: {} },
      observation: { ok: false, error: "ENOENT: no such file" },
    },
  ];
  const outcome = verifyTurn(
    { answer: "Готово, файл прочитан.", events, turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, false);
  assert.deepEqual(
    outcome.issues.map((issue) => issue.code),
    ["failed-tools"],
  );
});

test("verifyTurn passes when the tool failure is acknowledged in the answer", () => {
  const events: HistoryEvent[] = [
    ...baseEvents(),
    {
      type: "observation",
      call: { id: "r-1", name: "read", input: {} },
      observation: { ok: false, error: "ENOENT: no such file" },
    },
  ];
  const outcome = verifyTurn(
    { answer: "Файл не найден: ENOENT: no such file. Проверь путь.", events, turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, true);
});

test("verifyTurn passes when the answer names only the error code, not the full path", () => {
  const events: HistoryEvent[] = [
    ...baseEvents(),
    {
      type: "observation",
      call: { id: "r-1", name: "read", input: {} },
      observation: {
        ok: false,
        error: "ENOENT: no such file or directory, open 'C:\\Users\\pc\\tmp\\missing.txt'",
      },
    },
  ];
  const outcome = verifyTurn(
    { answer: "Чтение не удалось: ENOENT.", events, turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, true);
});

test("verifyTurn passes a paraphrase that acknowledges the failure without the error text", () => {
  const events: HistoryEvent[] = [
    ...baseEvents(),
    {
      type: "observation",
      call: { id: "r-1", name: "read", input: {} },
      observation: { ok: false, error: "ENOENT: no such file or directory" },
    },
  ];
  const outcome = verifyTurn(
    { answer: "Файл не найден, проверь путь.", events, turnStartIndex: 1 },
    allChecks,
  );

  assert.equal(outcome.ok, true);
});

test("verifyTurn ignores failures from earlier turns outside the gate window", () => {
  const events: HistoryEvent[] = [
    ...baseEvents(),
    {
      type: "observation",
      call: { id: "old", name: "bash", input: {} },
      observation: { ok: false, error: "command not found" },
    },
    {
      type: "observation",
      call: { id: "new", name: "echo", input: {} },
      observation: { ok: true, value: "ok" },
    },
  ];
  // The failing observation happened before the current turn (index < start).
  const outcome = verifyTurn({ answer: "Готово.", events, turnStartIndex: 3 }, allChecks);

  assert.equal(outcome.ok, true);
});

test("a turn that fails verification is re-prompted and completes with the corrected answer", async () => {
  const model: AgentModel = {
    async decide({ events }) {
      const verified = events.some((event) => event.type === "verification");
      return verified
        ? { type: "finish", answer: "Итог: README — это руководство по Ant." }
        : { type: "finish", answer: "   " };
    },
  };

  const result = await runAgent(createAgentState("Расскажи про README"), {
    model,
    environment: new ToolEnvironment([]),
    verification: allChecks,
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.answer, "Итог: README — это руководство по Ant.");
  assert.equal(result.state.events.filter((event) => event.type === "verification").length, 1);
});

test("verification stops retrying after maxRounds and still completes", async () => {
  let calls = 0;
  const model: AgentModel = {
    async decide() {
      calls += 1;
      return { type: "finish", answer: "" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([]),
    verification: allChecks,
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  // One initial finish + maxRounds retries.
  assert.equal(calls, 1 + allChecks.maxRounds);
  assert.equal(
    result.state.events.filter((event) => event.type === "verification").length,
    allChecks.maxRounds,
  );
});

test("verification is disabled when enabled is false", async () => {
  let calls = 0;
  const model: AgentModel = {
    async decide() {
      calls += 1;
      return { type: "finish", answer: "" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([]),
    verification: { ...allChecks, enabled: false },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(calls, 1);
  assert.equal(
    result.state.events.some((event) => event.type === "verification"),
    false,
  );
});

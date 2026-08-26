import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentState,
  formatVerificationSummary,
  isMutatingBashCommand,
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
  commands: [],
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

test("formatVerificationSummary renders passed and failed check lists", () => {
  assert.equal(formatVerificationSummary([], true), "");
  assert.match(formatVerificationSummary(["npm run check"], true), /npm run check.*✓/u);
  assert.match(formatVerificationSummary(["npm run check", "npm run format:check"], true), /✓.*✓/u);
  assert.match(formatVerificationSummary(["npm run check"], false), /не пройдены.*✗/u);
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

const editTool = {
  spec: { name: "edit", description: "edits a file", inputSchema: { type: "object" } },
  async execute() {
    return { ok: true };
  },
};

function bashTool(handler: (command: string) => { exitCode: number; output: string }) {
  return {
    spec: { name: "bash", description: "runs a command", inputSchema: { type: "object" } },
    async execute(input: unknown) {
      const command = (input as { command?: string }).command ?? "";
      return handler(command);
    },
  };
}

test("isMutatingBashCommand detects shell file mutations", () => {
  assert.equal(isMutatingBashCommand('echo "x" >> test.txt'), true);
  assert.equal(isMutatingBashCommand('echo "x" > test.txt'), true);
  assert.equal(isMutatingBashCommand("sed -i s/a/b/ file.txt"), true);
  assert.equal(isMutatingBashCommand("rm -rf node_modules"), true);
  assert.equal(isMutatingBashCommand("mv a b"), true);
  assert.equal(isMutatingBashCommand("cp a b"), true);
  assert.equal(isMutatingBashCommand("mkdir -p dist"), true);
  assert.equal(isMutatingBashCommand("touch .gitkeep"), true);
});

test("isMutatingBashCommand ignores read-only commands", () => {
  assert.equal(isMutatingBashCommand("tail -5 test.txt"), false);
  assert.equal(isMutatingBashCommand("git log --oneline -5"), false);
  assert.equal(isMutatingBashCommand("npm test"), false);
  assert.equal(isMutatingBashCommand("ls -la"), false);
  assert.equal(isMutatingBashCommand("node -v"), false);
});

test("verification commands run when the model mutates files through bash", async () => {
  let bashRuns = 0;
  const bash = bashTool(() => {
    bashRuns += 1;
    return { exitCode: 0, output: "ok" };
  });
  const model: AgentModel = {
    async decide({ events }) {
      const observations = events.filter((event) => event.type === "observation");
      return observations.length === 0
        ? {
            type: "tools",
            calls: [{ id: "b-1", name: "bash", input: { command: 'echo "x" >> test.txt' } }],
          }
        : { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([bash]),
    verification: { ...allChecks, commands: ["npm run check"] },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(bashRuns, 2); // the mutation itself + the verification command
  assert.equal(result.answer, "Готово");
  assert.match(result.verificationSummary ?? "", /Проверки перед завершением хода/u);
});

test("verification commands run after an editing turn and all pass", async () => {
  const bash = bashTool(() => ({ exitCode: 0, output: "ok" }));
  const model: AgentModel = {
    async decide({ events }) {
      const observations = events.filter((event) => event.type === "observation");
      return observations.length === 0
        ? {
            type: "tools",
            calls: [
              {
                id: "edit-1",
                name: "edit",
                input: { path: "a.txt", oldText: "x", newText: "y" },
              },
            ],
          }
        : { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Измени файл"), {
    model,
    environment: new ToolEnvironment([editTool, bash]),
    verification: { ...allChecks, commands: ["npm run check"] },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.answer, "Готово");
  assert.match(result.verificationSummary ?? "", /Проверки перед завершением хода/u);
  assert.match(result.verificationSummary ?? "", /`npm run check` ✓/u);
  const verifyObservations = result.state.events.filter(
    (event) => event.type === "observation" && event.call.id.startsWith("verify-cmd-"),
  );
  assert.equal(verifyObservations.length, 1);
});

test("a failing verification command re-prompts the model until it passes", async () => {
  let runs = 0;
  const bash = bashTool(() => {
    runs += 1;
    return runs === 1 ? { exitCode: 1, output: "check failed" } : { exitCode: 0, output: "ok" };
  });
  let calls = 0;
  const model: AgentModel = {
    async decide({ events }) {
      calls += 1;
      const observations = events.filter((event) => event.type === "observation");
      return observations.length === 0
        ? { type: "tools", calls: [{ id: "edit-1", name: "edit", input: {} }] }
        : { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([editTool, bash]),
    verification: { ...allChecks, commands: ["npm run check"] },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(runs, 2);
  assert.equal(calls, 3);
  assert.equal(result.state.events.filter((event) => event.type === "verification").length, 1);
  assert.match(result.verificationSummary ?? "", /Проверки перед завершением хода/u);
  assert.match(result.verificationSummary ?? "", /✓/u);
});

test("verification stops after maxRounds and reports the failed checks in the answer", async () => {
  const bash = bashTool(() => ({ exitCode: 1, output: "always broken" }));
  let calls = 0;
  const model: AgentModel = {
    async decide({ events }) {
      calls += 1;
      const observations = events.filter((event) => event.type === "observation");
      return observations.length === 0
        ? { type: "tools", calls: [{ id: "edit-1", name: "edit", input: {} }] }
        : { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([editTool, bash]),
    verification: { ...allChecks, commands: ["npm run check"] },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  // One initial finish + maxRounds retries, then the answer is accepted.
  assert.equal(calls, 1 + allChecks.maxRounds + 1);
  assert.equal(
    result.state.events.filter((event) => event.type === "verification").length,
    allChecks.maxRounds,
  );
  assert.match(result.verificationSummary ?? "", /не пройдены/u);
  assert.match(result.verificationSummary ?? "", /✗/u);
});

test("verification commands do not run when the turn made no edits", async () => {
  let bashRuns = 0;
  const bash = bashTool(() => {
    bashRuns += 1;
    return { exitCode: 0, output: "ok" };
  });
  const model: AgentModel = {
    async decide() {
      return { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Вопрос"), {
    model,
    environment: new ToolEnvironment([bash]),
    verification: { ...allChecks, commands: ["npm run check"] },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(bashRuns, 0);
  assert.equal(result.verificationSummary, undefined);
});

test("verification commands do not run when commands is empty", async () => {
  let bashRuns = 0;
  const bash = bashTool(() => {
    bashRuns += 1;
    return { exitCode: 0, output: "ok" };
  });
  const model: AgentModel = {
    async decide({ events }) {
      const observations = events.filter((event) => event.type === "observation");
      return observations.length === 0
        ? { type: "tools", calls: [{ id: "edit-1", name: "edit", input: {} }] }
        : { type: "finish", answer: "Готово" };
    },
  };

  const result = await runAgent(createAgentState("Задача"), {
    model,
    environment: new ToolEnvironment([editTool, bash]),
    verification: allChecks,
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(bashRuns, 0);
});

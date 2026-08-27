import assert from "node:assert/strict";
import test from "node:test";

import type { AntApplicationRunOptions } from "../packages/app/src/application.js";
import type { SessionList } from "../packages/app/src/session.js";
import {
  runCli,
  type CliAdapterModules,
  type CliApplication,
} from "../packages/cli/src/cli-adapter.js";
import { VERSION } from "../packages/contracts/src/version.js";

interface Harness {
  modules: CliAdapterModules;
  calls: string[];
  logs: string[];
  errors: string[];
  runs: AntApplicationRunOptions[];
}

function createHarness(list: SessionList = { sessions: [], warnings: [] }): Harness {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const runs: AntApplicationRunOptions[] = [];
  const application: CliApplication = {
    async run(options) {
      calls.push("application.run");
      runs.push(options);
    },
    async listSessions(workspace) {
      calls.push(`application.list:${workspace}`);
      return list;
    },
  };

  return {
    modules: {
      application,
      version: VERSION,
      applyEnvironment(workspace) {
        calls.push(`environment.apply:${workspace}`);
      },
      output: {
        log(message) {
          logs.push(message);
        },
        error(message) {
          errors.push(message);
        },
      },
    },
    calls,
    logs,
    errors,
    runs,
  };
}

test("CLI adapter handles help and version without invoking the application", async () => {
  const help = createHarness();
  await runCli({ workspace: "workspace", args: ["-h"] }, help.modules);
  assert.deepEqual(help.calls, ["environment.apply:workspace"]);
  assert.match(help.logs[0] ?? "", /Использование: ant/u);

  const version = createHarness();
  await runCli({ workspace: "workspace", args: ["-v"] }, version.modules);
  assert.deepEqual(version.calls, ["environment.apply:workspace"]);
  assert.deepEqual(version.logs, [VERSION]);
});

test("CLI adapter formats the session list returned by the application", async () => {
  const harness = createHarness({
    sessions: [
      {
        id: "session-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        task: "Сохранённая\nзадача",
      },
    ],
    warnings: ["повреждённая сессия"],
  });

  await runCli({ workspace: "workspace", args: ["-r"] }, harness.modules);

  assert.deepEqual(harness.calls, ["environment.apply:workspace", "application.list:workspace"]);
  assert.deepEqual(harness.errors, ["Предупреждение: повреждённая сессия"]);
  assert.match(harness.logs.join("\n"), /session-1.*Сохранённая задача/u);
});

test("CLI adapter maps parsed run options onto the application API", async () => {
  const resumed = createHarness();
  await runCli(
    { workspace: "workspace", args: ["-s", "session-7", "Продолжи", "задачу"] },
    resumed.modules,
  );
  assert.deepEqual(resumed.runs, [
    { workspace: "workspace", task: "Продолжи задачу", resume: "session-7" },
  ]);

  const latest = createHarness();
  await runCli({ workspace: "workspace", args: ["-c"] }, latest.modules);
  assert.deepEqual(latest.runs, [{ workspace: "workspace", task: "", continueLatest: true }]);
});

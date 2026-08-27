import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  formatTurnChangeSummary,
  TurnChangeTracker,
} from "../packages/frontend-terminal/src/turn-change-summary.js";

const execFileAsync = promisify(execFile);

async function createRepository(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "ant-summary-"));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: workspace });
  return workspace;
}

test("turn summary records bash commands and net Git changes", async () => {
  const workspace = await createRepository();
  const tracker = new TurnChangeTracker(workspace);
  await tracker.begin();

  const call = { id: "bash-1", name: "bash", input: { command: "build" } };
  tracker.onEvent({ type: "tool.started", call });
  await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
  tracker.onEvent({
    type: "tool.finished",
    call,
    observation: { ok: true, value: { exitCode: 0 } },
    durationMs: 10,
  });

  const summary = await tracker.finish();
  assert.deepEqual(summary.commands, ["build"]);
  assert.deepEqual(summary.changedFiles, [{ path: "tracked.txt", status: " M" }]);
  assert.match(summary.diffStat ?? "", /tracked\.txt/u);
});

test("turn summary detects edits to files that were already dirty", async () => {
  const workspace = await createRepository();
  await writeFile(join(workspace, "tracked.txt"), "dirty before\n", "utf8");
  const tracker = new TurnChangeTracker(workspace);
  await tracker.begin();
  await writeFile(join(workspace, "tracked.txt"), "dirty after\n", "utf8");

  const summary = await tracker.finish();
  assert.equal(summary.baselineDirty, true);
  assert.deepEqual(summary.changedFiles, [{ path: "tracked.txt", status: " M" }]);
  assert.equal(summary.diffStat, undefined);
});

test("successful write calls remain visible outside a Git repository", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ant-summary-"));
  const tracker = new TurnChangeTracker(workspace);
  await tracker.begin();
  const call = { id: "write-1", name: "write", input: { path: "notes.txt", content: "x" } };
  tracker.onEvent({ type: "tool.started", call });
  tracker.onEvent({
    type: "tool.finished",
    call,
    observation: { ok: true, value: { path: "notes.txt" } },
    durationMs: 2,
  });

  const summary = await tracker.finish();
  assert.equal(summary.gitAvailable, false);
  assert.deepEqual(summary.toolWrittenFiles, ["notes.txt"]);
  assert.match(formatTurnChangeSummary(summary) ?? "", /notes\.txt/u);
});

test("empty turn summary is omitted", () => {
  assert.equal(
    formatTurnChangeSummary({
      commands: [],
      changedFiles: [],
      toolWrittenFiles: [],
      gitAvailable: true,
      baselineDirty: false,
    }),
    undefined,
  );
});

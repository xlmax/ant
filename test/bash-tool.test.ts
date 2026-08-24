import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ToolEnvironment } from "../src/core/environment.js";
import { createBashTool } from "../src/tools/bash-tool.js";

function temporaryPidFileName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, "0");
    return true;
  } catch {
    return false;
  }
}

async function readChildPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    try {
      const content = (await fs.readFile(filePath, "utf8")).trim();
      const pid = Number.parseInt(content, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // wait for file
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`Failed to get pid from ${filePath}`);
}

function makePersistentChildCommand(pidFile: string): string {
  return `node -e "const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)']); fs.writeFileSync('${pidFile}', String(child.pid)); setTimeout(() => {}, 100000);"`;
}

async function cleanupPidFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

test("bash runs a command and returns its output", async () => {
  const environment = new ToolEnvironment([createBashTool(process.cwd())]);

  const observation = await environment.execute({
    id: "bash-call",
    name: "bash",
    input: { command: "printf 'hello\\n'" },
  });

  assert.deepEqual(observation, {
    ok: true,
    value: {
      exitCode: 0,
      output: "hello\n",
      truncated: false,
    },
  });
});

test("bash rejects timeout values above the hard limit", async () => {
  const environment = new ToolEnvironment([createBashTool(process.cwd())]);

  const observation = await environment.execute({
    id: "bash-timeout-limit",
    name: "bash",
    input: {
      command: "printf ''",
      timeout: 3601,
    },
  });

  assert.equal(observation.ok, false);
  assert.match((observation as { ok: false; error: string }).error, /must not exceed 3600 seconds/);
});

test("bash truncates UTF-8 output without breaking characters", async () => {
  const environment = new ToolEnvironment([createBashTool(process.cwd())]);

  const observation = await environment.execute({
    id: "bash-truncate-utf8",
    name: "bash",
    input: {
      command: "node -e \"process.stdout.write('€'.repeat(17067));\"",
    },
  });

  if (observation.ok === false) {
    throw new Error(observation.error);
  }

  const result = observation.value as {
    truncated: boolean;
    output: string;
  };
  assert.equal(result.truncated, true);
  assert.equal(result.output.includes("\uFFFD"), false);
  assert.equal(result.output.endsWith("€"), true);
});

test("bash keeps only a bounded tail of very large output", async () => {
  const environment = new ToolEnvironment([createBashTool(process.cwd())]);
  const observation = await environment.execute({
    id: "bash-bounded-output",
    name: "bash",
    input: { command: `node -e "process.stdout.write('x'.repeat(10 * 1024 * 1024) + 'TAIL')"` },
  });

  if (observation.ok === false) throw new Error(observation.error);
  const result = observation.value as { truncated: boolean; output: string };
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 50 * 1024);
  assert.equal(result.output.endsWith("TAIL"), true);
});

test("bash timeout kills the whole process tree", async () => {
  const tool = createBashTool(process.cwd());
  const pidFileName = temporaryPidFileName("bash-child-pid-timeout");
  const pidFilePath = path.join(process.cwd(), pidFileName);

  try {
    await assert.rejects(
      tool.execute({
        command: makePersistentChildCommand(pidFileName),
        timeout: 1,
      }),
      /bash timed out after 1 seconds/,
    );

    const childPid = await readChildPid(pidFilePath);
    assert.equal(isProcessRunning(childPid), false);
  } finally {
    await cleanupPidFile(pidFilePath);
  }
});

test("bash abort kills the whole process tree", async () => {
  const tool = createBashTool(process.cwd());
  const pidFileName = temporaryPidFileName("bash-child-pid-abort");
  const pidFilePath = path.join(process.cwd(), pidFileName);
  const controller = new AbortController();

  const execution = tool.execute(
    {
      command: makePersistentChildCommand(pidFileName),
    },
    controller.signal,
  );

  setTimeout(() => {
    controller.abort();
  }, 50);

  try {
    await assert.rejects(execution, /Operation aborted/);

    const childPid = await readChildPid(pidFilePath);
    assert.equal(isProcessRunning(childPid), false);
  } finally {
    await cleanupPidFile(pidFilePath);
  }
});

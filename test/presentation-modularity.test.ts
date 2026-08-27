import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AntApplicationApi } from "../packages/app/src/application-client.js";
import type { CommandContext } from "../packages/frontend-terminal/src/command-registry.js";
import { createBuiltinCommandRegistry } from "../packages/frontend-terminal/src/command-modules.js";
import type { ConsoleRenderer } from "../packages/frontend-terminal/src/console-renderer.js";
import type {
  ChangeTracker,
  GitPresentationService,
  ProcessControl,
  TerminalPort,
} from "../packages/frontend-terminal/src/presentation-ports.js";
import { TurnRunner } from "../packages/frontend-terminal/src/turn-runner.js";
import { runRepl } from "../packages/frontend-terminal/src/repl.js";

function terminal(output: string[]): TerminalPort {
  return {
    log: (message) => output.push(message),
    warn: (message) => output.push(message),
    error: (message) => output.push(message),
    write() {},
    clear() {},
    async read() {
      return "";
    },
    close() {},
  };
}

test("compact and update commands use injected process and update ports", async () => {
  const registry = createBuiltinCommandRegistry();
  const output: string[] = [];
  let listeners = 0;
  let removals = 0;
  let checks = 0;
  let installs = 0;
  const process: ProcessControl = {
    onInterrupt() {
      listeners += 1;
      return () => {
        removals += 1;
      };
    },
    timeout: () => new AbortController().signal,
    setExitCode() {},
  };
  const context = {
    options: { client: { compactContext: async () => ({ status: "no-session" }) } },
    renderer: {},
    terminal: terminal(output),
    process,
    updates: {
      managedByNpm: false,
      async check() {
        checks += 1;
        return { version: "9.0.0", url: "https://example.test/ant.tgz" };
      },
      async install() {
        installs += 1;
      },
    },
  } as unknown as CommandContext;

  const compact = registry.parse("/compact");
  const update = registry.parse("/update");
  assert.ok(compact && !("error" in compact));
  assert.ok(update && !("error" in update));
  await registry.dispatch(compact, context);
  await registry.dispatch(update, context);

  assert.equal(listeners, 1);
  assert.equal(removals, 1);
  assert.equal(checks, 1);
  assert.equal(installs, 1);
});

test("turn runner uses injected Git tracker and always removes its signal listener", async () => {
  let began = 0;
  let finished = 0;
  let removed = 0;
  let disposed = 0;
  const tracker: ChangeTracker = {
    async begin() {
      began += 1;
    },
    async finish() {
      finished += 1;
      return {
        commands: [],
        changedFiles: [],
        toolWrittenFiles: [],
        gitAvailable: false,
        baselineDirty: false,
      };
    },
    onEvent() {},
  };
  const git: GitPresentationService = {
    async branch() {
      return "test";
    },
    createChangeTracker() {
      return tracker;
    },
  };
  const process: ProcessControl = {
    onInterrupt() {
      return () => {
        removed += 1;
      };
    },
    timeout: () => new AbortController().signal,
    setExitCode() {},
  };
  const renderer = {
    beginTurn() {},
    onTextDelta() {},
    onReasoningDelta() {},
    async printResult() {},
    async printChangeSummary() {},
    printCancellationPending() {},
    dispose() {
      disposed += 1;
    },
  } as unknown as ConsoleRenderer;
  const client = {
    async submitTurn() {
      return {
        result: { status: "completed", answer: "ok", state: { events: [] } },
        session: { id: "test" },
      };
    },
  } as unknown as AntApplicationApi;

  await new TurnRunner({ workspace: ".", client, renderer, process, git, showChanges: true }).run(
    "task",
  );
  assert.deepEqual(
    { began, finished, removed, disposed },
    { began: 1, finished: 1, removed: 1, disposed: 1 },
  );
});

test("REPL uses injected terminal, updater and Git service and always closes input", async () => {
  let closed = 0;
  let branchChecks = 0;
  let updateChecks = 0;
  const output: string[] = [];
  const replTerminal = {
    ...terminal(output),
    async read() {
      return "/exit";
    },
    close() {
      closed += 1;
    },
  };
  const process: ProcessControl = {
    onInterrupt() {
      return () => {};
    },
    timeout: () => new AbortController().signal,
    setExitCode() {},
  };
  const git: GitPresentationService = {
    async branch() {
      branchChecks += 1;
      return "feature";
    },
    createChangeTracker() {
      throw new Error("turn tracker is not needed");
    },
  };
  const client = {
    activeSession: undefined,
    modelDescriptor: {
      providerId: "test",
      modelId: "model",
      contextWindow: 1_000,
      capabilities: {
        vision: false,
        reasoning: { supported: false, enabled: false, availableEfforts: [] },
      },
    },
  } as unknown as AntApplicationApi;

  await runRepl(
    {
      workspace: ".",
      client,
      settings: { async saveReasoningMode() {} },
      projectOverrides: {
        modelId: false,
        modelThinking: false,
        reasoningMode: false,
        showChanges: false,
      },
      reasoningMode: "off",
      reasoningMaxLines: 5,
      showChanges: false,
    },
    {
      terminal: replTerminal,
      process,
      git,
      updates: {
        managedByNpm: false,
        async check() {
          updateChecks += 1;
          return undefined;
        },
        async install() {},
      },
      commands: createBuiltinCommandRegistry(),
      createRenderer: () => ({}) as ConsoleRenderer,
      createTurnRunner: () => {
        throw new Error("turn runner is not needed");
      },
    },
  );

  assert.deepEqual(
    { closed, branchChecks, updateChecks },
    { closed: 1, branchChecks: 1, updateChecks: 1 },
  );
});

test("presentation orchestration depends on ports, not concrete process, updater or Git adapters", async () => {
  const files = await Promise.all(
    [
      "command-registry.ts",
      "command-modules.ts",
      "repl.ts",
      "terminal-frontend.ts",
      "turn-runner.ts",
    ].map(async (name) => ({
      name,
      content: await readFile(
        new URL(`../packages/frontend-terminal/src/${name}`, import.meta.url),
        "utf8",
      ),
    })),
  );
  for (const file of files) {
    assert.doesNotMatch(
      file.content,
      /node:process|node:readline|\.\.\/updates\/updates|TurnChangeTracker|ConsoleRenderer|initConsoleSize/u,
      file.name,
    );
  }
  const renderer = await readFile(
    new URL("../packages/frontend-terminal/src/console-renderer.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    renderer,
    /AntApplicationApi|UpdateService|GitPresentationService|node:process/u,
  );
});

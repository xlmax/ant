import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AntApplicationApi } from "../packages/app/src/application-client.js";
import type { CommandContext } from "../packages/frontend-terminal/src/command-registry.js";
import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { AgentLifecycle } from "../packages/frontend-terminal/src/agent-presence.js";
import { createBuiltinCommandRegistry } from "../packages/frontend-terminal/src/command-modules.js";
import type { ConsoleRenderer } from "../packages/frontend-terminal/src/console-renderer.js";
import type {
  ChangeTracker,
  GitPresentationService,
  ProcessControl,
  TerminalPort,
} from "../packages/frontend-terminal/src/presentation-ports.js";
import { TerminalFrontend } from "../packages/frontend-terminal/src/terminal-frontend.js";
import { TurnRunner } from "../packages/frontend-terminal/src/turn-runner.js";
import { runRepl } from "../packages/frontend-terminal/src/repl.js";

function lifecycle(states: string[] = [], sessions: string[] = []): AgentLifecycle {
  return new AgentLifecycle({
    setState: (state) => states.push(state),
    setSession: (sessionId) => sessions.push(sessionId),
    dispose() {},
  });
}

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
    async readSecret() {
      return "";
    },
    async confirm() {
      return true;
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
        return { status: "updated" as const };
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

test("update command explains manual recovery when Windows holds koffi.node", async () => {
  configureAnsi(false);
  try {
    const output: string[] = [];
    const url = "https://github.com/xlmax/ant/releases/download/v9.0.0/ant-9.0.0.tgz";
    const context = {
      options: { client: {} },
      renderer: {},
      terminal: terminal(output),
      process: {
        onInterrupt() {
          return () => {};
        },
        timeout: () => new AbortController().signal,
        setExitCode() {},
      },
      updates: {
        managedByNpm: false,
        async check() {
          return { version: "9.0.0", url };
        },
        async install() {
          return { status: "blocked-by-loaded-native-module" as const };
        },
      },
    } as unknown as CommandContext;
    const registry = createBuiltinCommandRegistry();
    const parsed = registry.parse("/update");
    assert.ok(parsed && !("error" in parsed));

    await registry.dispatch(parsed, context);

    const message = output.join("\n");
    assert.match(message, /1\. Выполните \/exit\./u);
    assert.match(message, /2\. В PowerShell выполните:/u);
    assert.match(message, new RegExp(`npm install -g ${url.replaceAll(".", "\\.")}`, "u"));
    assert.match(message, /3\. Продолжите сессию командой:\n {3}ant -c/u);
    assert.doesNotMatch(message, /EBUSY|4294963214|koffi\.node/u);
  } finally {
    configureAnsi(true);
  }
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

  const states: string[] = [];
  await new TurnRunner({
    workspace: ".",
    client,
    renderer,
    lifecycle: lifecycle(states),
    process,
    git,
    showChanges: true,
  }).run("task");
  assert.deepEqual(
    { began, finished, removed, disposed, states },
    { began: 1, finished: 1, removed: 1, disposed: 1, states: ["working", "idle"] },
  );
});

test("REPL uses injected services and leaves terminal cleanup to its owner", async () => {
  let closed = 0;
  let branchChecks = 0;
  let updateChecks = 0;
  const output: string[] = [];
  const replTerminal = {
    ...terminal(output),
    async read() {
      return undefined;
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
      lifecycle: lifecycle(),
      process,
      git,
      updates: {
        managedByNpm: false,
        async check() {
          updateChecks += 1;
          return undefined;
        },
        async install() {
          return { status: "updated" as const };
        },
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
    { closed: 0, branchChecks: 1, updateChecks: 1 },
  );
});

test("terminal frontend owns idle, stopped, and terminal cleanup", async () => {
  let closed = 0;
  const states: string[] = [];
  const ownedLifecycle = lifecycle(states);
  const output: string[] = [];
  const terminalPort = {
    ...terminal(output),
    async read() {
      return undefined;
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

  await new TerminalFrontend(
    {
      task: "",
      workspace: ".",
      color: true,
      settings: { async saveReasoningMode() {} },
      projectOverrides: {
        modelId: false,
        modelThinking: false,
        reasoningMode: false,
        showChanges: false,
      },
      showChanges: false,
      reasoningMode: "off",
      reasoningMaxLines: 5,
    },
    {
      createTerminal: () => terminalPort,
      lifecycle: ownedLifecycle,
      process,
      updates: {
        managedByNpm: false,
        async check() {
          return undefined;
        },
        async install() {
          return { status: "updated" };
        },
      },
      git,
      commands: createBuiltinCommandRegistry(),
      async initialize() {},
      createRenderer: () => ({}) as ConsoleRenderer,
      createTurnRunner: () => {
        throw new Error("turn runner is not needed");
      },
    },
  ).run(client);

  assert.deepEqual({ closed, states }, { closed: 1, states: ["idle", "stopped"] });
});

test("terminal frontend reports fatal errors before stopping", async () => {
  const states: string[] = [];
  const ownedLifecycle = lifecycle(states);
  const failure = new Error("startup failed");
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

  await assert.rejects(
    new TerminalFrontend(
      {
        task: "",
        workspace: ".",
        color: true,
        settings: { async saveReasoningMode() {} },
        projectOverrides: {
          modelId: false,
          modelThinking: false,
          reasoningMode: false,
          showChanges: false,
        },
        showChanges: false,
        reasoningMode: "off",
        reasoningMaxLines: 5,
      },
      {
        createTerminal: () => terminal([]),
        lifecycle: ownedLifecycle,
        process: {
          onInterrupt: () => () => {},
          timeout: () => new AbortController().signal,
          setExitCode() {},
        },
        updates: {
          managedByNpm: false,
          async check() {
            throw failure;
          },
          async install() {
            return { status: "updated" };
          },
        },
        git: {
          async branch() {
            return undefined;
          },
          createChangeTracker() {
            throw new Error("turn tracker is not needed");
          },
        },
        commands: createBuiltinCommandRegistry(),
        async initialize() {},
        createRenderer: () => ({}) as ConsoleRenderer,
        createTurnRunner: () => {
          throw new Error("turn runner is not needed");
        },
      },
    ).run(client),
    failure,
  );

  assert.deepEqual(states, ["idle", "error", "stopped"]);
});

test("REPL resume replays the last turn after the continuation banner", async () => {
  configureAnsi(false);
  try {
    const output: string[] = [];
    const replTerminal = {
      ...terminal(output),
      async read() {
        return undefined;
      },
      write(message: string) {
        output.push(message);
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
          reasoning: { supported: true, enabled: true, effort: "high", availableEfforts: [] },
        },
      },
      async resumeSession(sessionId: string) {
        return { session: { id: sessionId } };
      },
      getLastTurnEvents() {
        return [
          { type: "user", content: "Сделай это" },
          {
            type: "decision",
            decision: {
              type: "tools",
              reasoning: "Сначала читаю файл.",
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
            decision: { type: "finish", answer: "Готово" },
          },
        ];
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
        reasoningMode: "full",
        reasoningMaxLines: 5,
        showChanges: false,
        resume: "session-1",
      },
      {
        terminal: replTerminal,
        lifecycle: lifecycle(),
        process,
        git,
        updates: {
          managedByNpm: false,
          async check() {
            return undefined;
          },
          async install() {
            return { status: "updated" as const };
          },
        },
        commands: createBuiltinCommandRegistry(),
        createRenderer: () => ({}) as ConsoleRenderer,
        createTurnRunner: () => {
          throw new Error("turn runner is not needed");
        },
      },
    );

    const joined = output.join("\n");
    assert.match(joined, /Продолжена сессия: session-1/u);
    assert.match(joined, /Сделай это/u);
    assert.match(joined, /Сначала читаю файл\./u);
    assert.match(joined, /→ read src\/app\.ts/u);
    assert.match(joined, /✓ read/u);
    assert.match(joined, /Готово/u);
    assert.doesNotMatch(joined, /SECRET-RAW/u);
  } finally {
    configureAnsi(true);
  }
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

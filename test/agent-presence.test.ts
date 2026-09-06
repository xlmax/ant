import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  AgentLifecycle,
  createAgentPresence,
  runPresenceCommand,
  type AgentPresence,
  type AgentPresenceEnvironment,
} from "../packages/frontend-terminal/src/agent-presence.js";

const HERDR_ENVIRONMENT: AgentPresenceEnvironment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "pane-1",
  HERDR_BIN_PATH: "/opt/herdr",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
};

function recordingPresence(states: string[], sessions: string[] = []): AgentPresence {
  return {
    setState: (state) => states.push(state),
    setSession: (sessionId) => sessions.push(sessionId),
    dispose() {},
  };
}

test("ANT lifecycle owns runtime state transitions", () => {
  const states: string[] = [];
  const lifecycle = new AgentLifecycle(recordingPresence(states));

  lifecycle.start();
  lifecycle.markWorking();
  lifecycle.onEvent({ type: "model.requested", attempt: 1, maxAttempts: 1 });
  lifecycle.markIdle();
  lifecycle.onEvent({
    type: "tool.started",
    call: { id: "read-1", name: "read", input: {} },
  });
  lifecycle.markIdle();
  lifecycle.onEvent({ type: "verification", feedback: "retry", round: 1, maxRounds: 1 });
  lifecycle.markIdle();
  lifecycle.markFatalError();
  lifecycle.stop();
  lifecycle.stop();

  assert.equal(lifecycle.state, "stopped");
  assert.deepEqual(states, [
    "idle",
    "working",
    "idle",
    "working",
    "idle",
    "working",
    "idle",
    "error",
    "stopped",
  ]);
});

test("user confirmation restores the preceding lifecycle state", async () => {
  const states: string[] = [];
  const lifecycle = new AgentLifecycle(recordingPresence(states));
  lifecycle.markWorking();

  const answer = await lifecycle.waitForUser(async () => {
    assert.equal(lifecycle.state, "waiting_user");
    return "yes";
  });
  assert.equal(answer, "yes");
  assert.equal(lifecycle.state, "working");

  await assert.rejects(
    lifecycle.waitForUser(async () => {
      throw new Error("cancelled");
    }),
    /cancelled/u,
  );
  assert.equal(lifecycle.state, "working");
  assert.deepEqual(states, ["working", "waiting_user", "working", "waiting_user", "working"]);
});

test("presence failures never escape the lifecycle boundary", async () => {
  const failure = new Error("presence unavailable");
  const lifecycle = new AgentLifecycle({
    setState() {
      throw failure;
    },
    setSession() {
      throw failure;
    },
    dispose() {
      throw failure;
    },
  });

  assert.doesNotThrow(() => lifecycle.start());
  assert.doesNotThrow(() => lifecycle.markWorking());
  assert.doesNotThrow(() => lifecycle.setSession("session-1"));
  assert.equal(await lifecycle.waitForUser(async () => 42), 42);
  assert.doesNotThrow(() => lifecycle.stop());
});

test("OSC is the TTY fallback and never exposes session ids", () => {
  const writes: string[] = [];
  const presence = createAgentPresence({
    environment: {},
    isTTY: true,
    write: (text) => writes.push(text),
  });

  presence.setSession("session-secret");
  presence.setState("idle");
  presence.setState("working");
  presence.setState("waiting_user");
  presence.setState("error");
  presence.setState("stopped");

  assert.ok(writes.some((line) => line.includes("ANT · working")));
  assert.ok(writes.some((line) => line.includes("ANT · waiting")));
  assert.ok(writes.some((line) => line.includes("ANT · error")));
  assert.ok(writes.some((line) => line.includes("ANT · stopped")));
  assert.ok(!writes.some((line) => line.includes("session-secret")));
});

test("Herdr requires both a host pane and an integration endpoint", () => {
  const commands: string[] = [];
  for (const environment of [
    { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1" },
    { HERDR_ENV: "1", HERDR_BIN_PATH: "/opt/herdr" },
    { HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
  ]) {
    const presence = createAgentPresence({
      environment,
      isTTY: false,
      runCommand: (command, args) => commands.push([command, ...args].join(" ")),
    });
    presence.setState("working");
    presence.dispose();
  }

  assert.deepEqual(commands, []);
});

test("Herdr reports lifecycle and session with monotonic sequences", () => {
  const commands: string[][] = [];
  let sequence = 100;
  const presence = createAgentPresence({
    environment: HERDR_ENVIRONMENT,
    isTTY: false,
    runCommand: (command, args) => commands.push([command, ...args]),
    nextSequence: () => String((sequence += 1)),
  });

  presence.setState("idle");
  presence.setSession("session-1");
  presence.setState("working");
  presence.setState("waiting_user");
  presence.setState("error");
  presence.setState("stopped");
  presence.dispose();

  assert.equal(commands.length, 6);
  assert.deepEqual(
    commands.map((command) => command[2]),
    [
      "report-agent",
      "report-agent-session",
      "report-agent",
      "report-agent",
      "report-agent",
      "release-agent",
    ],
  );
  assert.deepEqual(
    commands.map((command) => command[command.indexOf("--seq") + 1]),
    ["101", "102", "103", "104", "105", "106"],
  );
  assert.equal(commands[3]?.includes("blocked"), true);
  assert.equal(commands[4]?.includes("unknown"), true);
});

test("OSC remains active alongside a detected Herdr host", () => {
  const writes: string[] = [];
  const commands: string[] = [];
  const presence = createAgentPresence({
    environment: HERDR_ENVIRONMENT,
    isTTY: true,
    write: (text) => writes.push(text),
    runCommand: (command, args) => commands.push([command, ...args].join(" ")),
    nextSequence: () => "1",
  });

  presence.setState("working");

  assert.equal(
    writes.some((line) => line.includes("ANT · working")),
    true,
  );
  assert.equal(commands.length, 1);
});

test("Herdr does not emit OSC controls when stdout is redirected", () => {
  const writes: string[] = [];
  const commands: string[] = [];
  const presence = createAgentPresence({
    environment: HERDR_ENVIRONMENT,
    isTTY: false,
    write: (text) => writes.push(text),
    runCommand: (command, args) => commands.push([command, ...args].join(" ")),
    nextSequence: () => "1",
  });

  presence.setState("working");

  assert.deepEqual(writes, []);
  assert.equal(commands.length, 1);
});

test("OSC and Herdr failures are independently isolated", () => {
  const presence = createAgentPresence({
    environment: HERDR_ENVIRONMENT,
    isTTY: true,
    write() {
      throw new Error("terminal closed");
    },
    runCommand() {
      throw new Error("Herdr unavailable");
    },
  });

  assert.doesNotThrow(() => presence.setSession("session-1"));
  assert.doesNotThrow(() => presence.setState("working"));
  assert.doesNotThrow(() => presence.dispose());
});

test("default Herdr sequences remain monotonic across adapter recreation", () => {
  const sequences: bigint[] = [];
  for (let index = 0; index < 2; index += 1) {
    const presence = createAgentPresence({
      environment: HERDR_ENVIRONMENT,
      isTTY: false,
      runCommand: (_command, args) => {
        const position = args.indexOf("--seq");
        sequences.push(BigInt(args[position + 1] ?? "0"));
      },
    });
    presence.setState("working");
    presence.dispose();
  }

  assert.equal(sequences.length, 4);
  assert.equal(
    sequences.every((value, index) => index === 0 || value > sequences[index - 1]!),
    true,
  );
});

test("detached Herdr spawn absorbs asynchronous errors", () => {
  const child = new EventEmitter() as EventEmitter & { unref(): void };
  let unrefCalls = 0;
  let spawnOptions: { detached?: boolean; shell?: boolean } | undefined;
  child.unref = () => {
    unrefCalls += 1;
  };
  const fakeSpawn = ((_command: string, _args: readonly string[], options: typeof spawnOptions) => {
    spawnOptions = options;
    return child;
  }) as unknown as typeof spawn;

  runPresenceCommand("missing-herdr", [], fakeSpawn);

  assert.equal(unrefCalls, 1);
  assert.equal(spawnOptions?.detached, true);
  assert.equal(spawnOptions?.shell, false);
  assert.doesNotThrow(() => child.emit("error", new Error("ENOENT")));
});

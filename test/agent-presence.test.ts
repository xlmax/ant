import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLifecycle,
  createAgentPresence,
  type AgentPresence,
} from "../packages/frontend-terminal/src/agent-presence.js";

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

test("OSC title is the only TTY presence output and never exposes session ids", () => {
  const writes: string[] = [];
  const presence = createAgentPresence({
    isTTY: true,
    write: (text) => writes.push(text),
  });

  presence.setSession("session-secret");
  presence.setState("idle");
  presence.setState("working");
  presence.setState("waiting_user");
  presence.setState("error");
  presence.setState("stopped");

  assert.deepEqual(writes, [
    "\u001B]0;ANT\u0007",
    "\u001B]0;ANT · working\u0007",
    "\u001B]0;ANT · waiting\u0007",
    "\u001B]0;ANT · error\u0007",
    "\u001B]0;ANT · stopped\u0007",
  ]);
  assert.ok(!writes.some((line) => line.includes("session-secret")));
  assert.ok(!writes.some((line) => line.startsWith("\u001B]9999;")));
});

test("duplicate OSC titles are suppressed", () => {
  const writes: string[] = [];
  const presence = createAgentPresence({
    isTTY: true,
    write: (text) => writes.push(text),
  });

  presence.setState("working");
  presence.setState("working");

  assert.deepEqual(writes, ["\u001B]0;ANT · working\u0007"]);
});

test("presence output is disabled when stdout is not a TTY", () => {
  const writes: string[] = [];
  const presence = createAgentPresence({
    isTTY: false,
    write: (text) => writes.push(text),
  });

  presence.setState("working");
  presence.dispose();

  assert.deepEqual(writes, []);
});

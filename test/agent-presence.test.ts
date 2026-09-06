import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentPresence,
  type AgentPresenceOptions,
} from "../packages/frontend-terminal/src/agent-presence.js";

function createHerdrOptions(overrides: Partial<AgentPresenceOptions> = {}): AgentPresenceOptions {
  return {
    environment: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "pane-1",
      HERDR_BIN_PATH: "herdr",
    },
    isTTY: true,
    ...overrides,
  };
}

test("agent presence is a no-op when no terminal host is available", () => {
  const writes: string[] = [];
  const presence = createAgentPresence({
    environment: {},
    isTTY: false,
    write: (text) => writes.push(text),
  });

  presence.setSession("session-secret");
  presence.setState("working");
  presence.setState("waiting_user");
  presence.setState("error");
  presence.setState("stopped");
  presence.dispose();

  assert.deepEqual(writes, []);
});

test("OSC fallback updates the terminal title without leaking session ids", () => {
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

  assert.ok(writes.some((line) => line.includes("ANT")));
  assert.ok(writes.some((line) => line.includes("ANT · working")));
  assert.ok(writes.some((line) => line.includes("ANT · waiting")));
  assert.ok(writes.some((line) => line.includes("ANT · error")));
  assert.ok(writes.some((line) => line.includes("ANT · stopped")));
  assert.ok(!writes.some((line) => line.includes("session-secret")));
});

test("Herdr presence reports lifecycle and release without blocking the turn", () => {
  const commands: string[] = [];
  const presence = createAgentPresence(
    createHerdrOptions({
      runCommand: (command, args) => {
        commands.push([command, ...args].join(" "));
      },
      write: () => {},
    }),
  );

  presence.setSession("session-1");
  presence.setState("working");
  presence.setState("waiting_user");
  presence.setState("error");
  presence.setState("stopped");
  presence.dispose();

  assert.deepEqual(commands, [
    "herdr pane report-agent-session pane-1 --source custom:ant --agent ant --seq 1 --agent-session-id session-1",
    "herdr pane report-agent pane-1 --source custom:ant --agent ant --state working --seq 2 --agent-session-id session-1",
    "herdr pane report-agent pane-1 --source custom:ant --agent ant --state blocked --seq 3 --message waiting for user input --agent-session-id session-1",
    "herdr pane report-agent pane-1 --source custom:ant --agent ant --state unknown --seq 4 --agent-session-id session-1",
    "herdr pane release-agent pane-1 --source custom:ant --agent ant --seq 5",
  ]);
});

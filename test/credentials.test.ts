import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandContext } from "../packages/frontend-terminal/src/command-registry.js";
import type { TerminalPort } from "../packages/frontend-terminal/src/presentation-ports.js";
import {
  CredentialStoreError,
  FileCredentialStore,
  defaultCredentialPath,
} from "../packages/cli/src/credentials/credential-store.js";
import { DeepSeekCredentialManager } from "../packages/cli/src/credentials/deepseek-credentials.js";
import { createKeyCommand } from "../packages/cli/src/credentials/key-command.js";

interface FakeTerminal extends TerminalPort {
  output: string[];
  secrets: (string | undefined)[];
  confirmations: (boolean | undefined)[];
}

function terminal(
  secrets: (string | undefined)[] = [],
  confirmations: (boolean | undefined)[] = [],
): FakeTerminal {
  const output: string[] = [];
  return {
    output,
    secrets: [...secrets],
    confirmations: [...confirmations],
    log: (message) => output.push(message),
    warn: (message) => output.push(message),
    error: (message) => output.push(message),
    write: (message) => output.push(message),
    clear() {},
    async read() {
      return "";
    },
    async readSecret() {
      return this.secrets.shift();
    },
    async confirm() {
      return this.confirmations.shift();
    },
    close() {},
  };
}

async function temporaryStore(): Promise<{ root: string; store: FileCredentialStore }> {
  const root = await mkdtemp(join(tmpdir(), "ant-credentials-"));
  return { root, store: new FileCredentialStore(join(root, "config", "credentials.json")) };
}

test("credential path uses the platform user configuration directory", () => {
  assert.equal(
    defaultCredentialPath("linux", { XDG_CONFIG_HOME: "/config" }),
    join("/config", "ant", "credentials.json"),
  );
  assert.equal(
    defaultCredentialPath("android", { XDG_CONFIG_HOME: "/data/config" }),
    join("/data/config", "ant", "credentials.json"),
  );
  assert.equal(
    defaultCredentialPath("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }),
    join("C:\\Users\\test\\AppData\\Roaming", "ant", "credentials.json"),
  );
});

test("environment key has priority over stored credentials", async () => {
  const item = await temporaryStore();
  try {
    await item.store.writeDeepSeekKey("stored-secret");
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: terminal(),
      interactive: false,
      environment: { DEEPSEEK_API_KEY: " environment-secret " },
    });
    assert.deepEqual(await manager.resolve(), {
      apiKey: "environment-secret",
      source: "environment",
    });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("stored credential is reused on a later manager instance", async () => {
  const item = await temporaryStore();
  try {
    await item.store.writeDeepSeekKey("stored-secret");
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: terminal(),
      interactive: false,
      environment: {},
    });
    assert.deepEqual(await manager.resolve(), {
      apiKey: "stored-secret",
      source: "credentials",
    });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("missing key starts interactive onboarding and never prints the secret", async () => {
  const item = await temporaryStore();
  const fake = terminal(["", "new-secret"], [false]);
  try {
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: true,
      environment: {},
    });
    assert.deepEqual(await manager.resolve(), { apiKey: "new-secret", source: "session" });
    assert.equal(fake.output.join("\n").includes("new-secret"), false);
    await assert.rejects(readFile(item.store.path, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("non-interactive missing key gives actionable error without prompting", async () => {
  const item = await temporaryStore();
  const fake = terminal(["must-not-be-read"]);
  try {
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: false,
      environment: {},
    });
    await assert.rejects(manager.resolve(), /Set DEEPSEEK_API_KEY/u);
    assert.equal(fake.secrets.length, 1);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("credential save creates private Unix directory and file", async (context) => {
  if (process.platform === "win32") return context.skip("Unix permissions");
  const item = await temporaryStore();
  try {
    await item.store.writeDeepSeekKey("saved-secret");
    assert.equal((await stat(join(item.root, "config"))).mode & 0o777, 0o700);
    assert.equal((await stat(item.store.path)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(item.store.path, "utf8")).deepseek.apiKey,
      "saved-secret",
    );
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("corrupt credentials are reported and not overwritten without confirmation", async () => {
  const item = await temporaryStore();
  const fake = terminal(["session-secret"], [false]);
  try {
    await mkdir(join(item.root, "config"));
    await writeFile(item.store.path, "{broken", "utf8");
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: true,
      environment: {},
    });
    assert.deepEqual(await manager.resolve(), { apiKey: "session-secret", source: "session" });
    assert.equal(await readFile(item.store.path, "utf8"), "{broken");
    assert.match(fake.output.join("\n"), /invalid JSON/u);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("empty stored key is treated as corrupt", async () => {
  const item = await temporaryStore();
  try {
    await mkdir(join(item.root, "config"));
    await writeFile(item.store.path, '{"deepseek":{"apiKey":" "}}', "utf8");
    await assert.rejects(item.store.readDeepSeekKey(), (error: unknown) => {
      return error instanceof CredentialStoreError && error.kind === "corrupt";
    });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("credential write failures are wrapped without exposing the key", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-credentials-failure-"));
  const parentFile = join(root, "not-a-directory");
  const secret = "never-print-this";
  try {
    await writeFile(parentFile, "occupied", "utf8");
    const store = new FileCredentialStore(join(parentFile, "credentials.json"));
    await assert.rejects(store.writeDeepSeekKey(secret), (error: unknown) => {
      return error instanceof CredentialStoreError && !error.message.includes(secret);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Ctrl+C cancels key entry", async () => {
  const item = await temporaryStore();
  try {
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: terminal([undefined]),
      interactive: true,
      environment: {},
    });
    await assert.rejects(manager.resolve(), /cancelled/u);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("credential onboarding follows an external cancellation signal", async () => {
  const item = await temporaryStore();
  const cancel = new AbortController();
  const fake = terminal();
  let markPromptStarted: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  fake.readSecret = async (_prompt, signal) => {
    markPromptStarted?.();
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return undefined;
  };
  try {
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: true,
      environment: {},
    });
    const pending = manager.resolve(cancel.signal);
    await promptStarted;
    cancel.abort();
    await assert.rejects(pending, /cancelled/u);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("key command reports source, saves and clears without revealing secrets", async () => {
  const item = await temporaryStore();
  const fake = terminal(["command-secret"]);
  try {
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: true,
      environment: {},
    });
    const command = createKeyCommand(manager);
    const context = { terminal: fake } as unknown as CommandContext;
    await command.handle("status", context);
    await command.handle("set", context);
    await command.handle("status", context);
    await command.handle("clear", context);
    const output = fake.output.join("\n");
    assert.match(output, /not configured/u);
    assert.match(output, /source: ANT credentials/u);
    assert.equal(output.includes("command-secret"), false);
    await assert.rejects(readFile(item.store.path, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("key clear never changes or hides an environment key", async () => {
  const item = await temporaryStore();
  const fake = terminal();
  try {
    await item.store.writeDeepSeekKey("stored-secret");
    const environment = { DEEPSEEK_API_KEY: "environment-secret" };
    const manager = new DeepSeekCredentialManager({
      store: item.store,
      terminal: fake,
      interactive: true,
      environment,
    });
    await createKeyCommand(manager).handle("clear", {
      terminal: fake,
    } as unknown as CommandContext);
    assert.equal(environment.DEEPSEEK_API_KEY, "environment-secret");
    assert.match(fake.output.join("\n"), /still has priority/u);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

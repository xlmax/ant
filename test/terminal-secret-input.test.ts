import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { readHiddenTerminalInput } from "../packages/frontend-terminal/src/terminal-secret-input.js";

class FakeSecretInput extends EventEmitter {
  isRaw = false;
  isTTY = true;
  readableFlowing: boolean | null = null;
  readonly rawModes: boolean[] = [];

  pause(): this {
    this.readableFlowing = false;
    return this;
  }
  resume(): this {
    this.readableFlowing = true;
    return this;
  }
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

class FakeSecretOutput {
  isTTY = true;
  value = "";
  write(value: string): void {
    this.value += value;
  }
}

async function startSecret(): Promise<{
  input: FakeSecretInput;
  output: FakeSecretOutput;
  result: Promise<string | undefined>;
}> {
  const input = new FakeSecretInput();
  const output = new FakeSecretOutput();
  const result = readHiddenTerminalInput("API key: ", { input, output });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { input, output, result };
}

test("hidden terminal input masks characters and handles backspace", async () => {
  const active = await startSecret();
  active.input.emit("data", "abc\u007Fd\r");
  assert.equal(await active.result, "abd");
  assert.equal(active.output.value, "API key: ***\b \b*\n");
  assert.deepEqual(active.input.rawModes, [true, false]);
  assert.equal(active.input.readableFlowing, false);
});

test("hidden terminal input restores raw mode when Ctrl+C cancels", async () => {
  const active = await startSecret();
  active.input.emit("data", "secret\u0003");
  assert.equal(await active.result, undefined);
  assert.equal(active.output.value.includes("secret"), false);
  assert.deepEqual(active.input.rawModes, [true, false]);
});

test("hidden terminal input restores raw mode when an external signal cancels", async () => {
  const input = new FakeSecretInput();
  const output = new FakeSecretOutput();
  const cancel = new AbortController();
  const result = readHiddenTerminalInput("API key: ", {
    input,
    output,
    signal: cancel.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  cancel.abort();

  assert.equal(await result, undefined);
  assert.equal(output.value, "API key: \n");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.readableFlowing, false);
});

test("hidden terminal input rejects non-TTY streams without enabling raw mode", async () => {
  const input = new FakeSecretInput();
  const output = new FakeSecretOutput();
  input.isTTY = false;
  await assert.rejects(readHiddenTerminalInput("API key: ", { input, output }), /недоступен/u);
  assert.deepEqual(input.rawModes, []);
});

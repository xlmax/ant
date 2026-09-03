import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AndroidInputDecoder } from "../packages/frontend-terminal/src/android-input.js";
import { InputHistory } from "../packages/frontend-terminal/src/input-history.js";
import {
  readAndroidTerminalInput,
  usesCustomTerminalInput,
} from "../packages/frontend-terminal/src/terminal-input.js";

const ENABLE_BRACKETED_PASTE = "\u001B[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001B[?2004l";

class FakeInput extends EventEmitter {
  isRaw = false;
  paused = true;
  resumeChunk: string | undefined;
  readonly rawModes: boolean[] = [];

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    if (this.resumeChunk !== undefined) {
      const chunk = this.resumeChunk;
      this.resumeChunk = undefined;
      this.emit("data", chunk);
    }
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }
}

class FakeOutput {
  readonly columns = 80;
  value = "";

  write(value: string): void {
    this.value += value;
  }
}

async function startInput(
  history = new InputHistory(),
  signal?: AbortSignal,
): Promise<{
  input: FakeInput;
  output: FakeOutput;
  result: Promise<string | undefined>;
}> {
  const input = new FakeInput();
  const output = new FakeOutput();
  const result = readAndroidTerminalInput(history, "› ", {
    input,
    output,
    ...(signal === undefined ? {} : { signal }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { input, output, result };
}

async function readChunks(
  chunks: readonly (string | Buffer)[],
  history = new InputHistory(),
): Promise<{ value: string | undefined; input: FakeInput; output: FakeOutput }> {
  const active = await startInput(history);
  for (const chunk of chunks) active.input.emit("data", chunk);
  const value = await active.result;
  return { ...active, value };
}

function assertTerminalRestored(input: FakeInput, output: FakeOutput): void {
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.ok(output.value.startsWith(ENABLE_BRACKETED_PASTE));
  assert.ok(output.value.endsWith(DISABLE_BRACKETED_PASTE));
}

test("Android input maps CR to submit and LF to newline", () => {
  const decoder = new AndroidInputDecoder();

  assert.deepEqual(decoder.write("\r\n"), [
    { type: "action", action: { type: "submit" } },
    { type: "action", action: { type: "newline" } },
  ]);
});

test("Android input maps Alt+CR and Alt+LF to newline", () => {
  const decoder = new AndroidInputDecoder();

  assert.deepEqual(decoder.write("\u001B\r\u001B\n"), [
    { type: "action", action: { type: "newline" } },
    { type: "action", action: { type: "newline" } },
  ]);
});

test("Android raw input submits ordinary text with CR", async () => {
  const { value, input, output } = await readChunks(["hello\r"]);

  assert.equal(value, "hello");
  assertTerminalRestored(input, output);
});

test("Android raw input subscribes before resuming stdin", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.resumeChunk = "ready\r";

  const value = await readAndroidTerminalInput(new InputHistory(), "› ", { input, output });

  assert.equal(value, "ready");
  assertTerminalRestored(input, output);
});

test("Android raw input builds multiline drafts with Ctrl+J and Alt+Enter", async () => {
  const ctrlJ = await readChunks(["hello\nworld\r"]);
  const altEnter = await readChunks(["hello\u001B", "\rworld\r"]);
  const altLf = await readChunks(["hello\u001B\nworld\r"]);

  assert.equal(ctrlJ.value, "hello\nworld");
  assert.equal(altEnter.value, "hello\nworld");
  assert.equal(altLf.value, "hello\nworld");
});

test("Android raw input reuses editor backspace, delete, and cursor movement", async () => {
  const { value } = await readChunks(["abx\u007Fc\u001B[D\u001B[3~d\r"]);

  assert.equal(value, "abd");
});

test("Android Ctrl+C clears the current draft and keeps editing", async () => {
  const { value, input, output } = await readChunks(["discard\u0003kept\r"]);

  assert.equal(value, "kept");
  assertTerminalRestored(input, output);
});

test("Android Ctrl+C exits when the current draft is empty", async () => {
  const { value, input, output } = await readChunks(["\u0003"]);

  assert.equal(value, undefined);
  assertTerminalRestored(input, output);
});

test("Android second Ctrl+C exits after the first one clears the draft", async () => {
  const { value, input, output } = await readChunks(["discard\u0003\u0003"]);

  assert.equal(value, undefined);
  assertTerminalRestored(input, output);
});

test("Android raw input browses existing multiline history", async () => {
  const history = new InputHistory();
  history.add("first\nsecond");

  const { value } = await readChunks(["\u001B[A\r"], history);

  assert.equal(value, "first\nsecond");
});

test("Android bracketed paste preserves lines and never submits inside its payload", async () => {
  const { value, input, output } = await readChunks([
    "\u001B[200~hello\r",
    "\nworld\nthird\u001B[20",
    "1~\r",
  ]);

  assert.equal(value, "hello\nworld\nthird");
  assertTerminalRestored(input, output);
});

test("Android input decoder preserves UTF-8 characters split across chunks", async () => {
  const bytes = Buffer.from("привет\r");
  const { value } = await readChunks([bytes.subarray(0, 3), bytes.subarray(3)]);

  assert.equal(value, "привет");
});

test("Android raw mode and bracketed paste are restored after an input error", async () => {
  const active = await startInput();
  const failure = new Error("input failed");
  active.input.emit("error", failure);

  await assert.rejects(active.result, failure);
  assertTerminalRestored(active.input, active.output);
});

test("Android raw mode and bracketed paste are restored after abort", async () => {
  const abort = new AbortController();
  const active = await startInput(new InputHistory(), abort.signal);
  abort.abort();

  await assert.rejects(active.result, { name: "AbortError" });
  assertTerminalRestored(active.input, active.output);
});

test("custom terminal input is selected only for TTY Windows and Android", () => {
  assert.equal(usesCustomTerminalInput("android", true), true);
  assert.equal(usesCustomTerminalInput("win32", true), true);
  assert.equal(usesCustomTerminalInput("linux", true), false);
  assert.equal(usesCustomTerminalInput("darwin", true), false);
  assert.equal(usesCustomTerminalInput("android", false), false);
});

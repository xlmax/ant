import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { VtInputDecoder } from "../packages/frontend-terminal/src/vt-input.js";
import { InputHistory } from "../packages/frontend-terminal/src/input-history.js";
import {
  readVtTerminalInput,
  selectTerminalInputBackend,
  usesCustomTerminalInput,
} from "../packages/frontend-terminal/src/terminal-input.js";

const ENABLE_BRACKETED_PASTE = "\u001B[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001B[?2004l";

class FakeInput extends EventEmitter {
  isRaw = false;
  readableFlowing: boolean | null = null;
  resumeChunk: string | undefined;
  readonly rawModes: boolean[] = [];

  isPaused(): boolean {
    return this.readableFlowing === false;
  }

  pause(): this {
    this.readableFlowing = false;
    return this;
  }

  resume(): this {
    this.readableFlowing = true;
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
  const result = readVtTerminalInput(history, "› ", {
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

test("VT input maps CR to submit and LF to newline", () => {
  const decoder = new VtInputDecoder();

  assert.deepEqual(decoder.write("\r\n"), [
    { type: "action", action: { type: "submit" } },
    { type: "action", action: { type: "newline" } },
  ]);
});

test("VT input maps Alt+CR and Alt+LF to newline", () => {
  const decoder = new VtInputDecoder();

  assert.deepEqual(decoder.write("\u001B\r\u001B\n"), [
    { type: "action", action: { type: "newline" } },
    { type: "action", action: { type: "newline" } },
  ]);
});

test("VT input maps Kitty and xterm modified Enter sequences to newline", () => {
  const decoder = new VtInputDecoder();

  assert.deepEqual(decoder.write("\u001B[13;2u\u001B[27;5;13~"), [
    { type: "action", action: { type: "newline" } },
    { type: "action", action: { type: "newline" } },
  ]);
});

test("VT input buffers split sequences and consumes unknown sequences", () => {
  const decoder = new VtInputDecoder();

  assert.deepEqual(decoder.write("\u001B[13;"), []);
  assert.deepEqual(decoder.write("2u\u001B[15"), [{ type: "action", action: { type: "newline" } }]);
  assert.deepEqual(decoder.write("~x"), [
    { type: "action", action: { type: "ignore" } },
    { type: "action", action: { type: "character", value: "x" } },
  ]);
});

test("VT input accepts parameterized CSI and SS3 navigation", () => {
  const decoder = new VtInputDecoder();

  assert.deepEqual(decoder.write("\u001B[1;5D\u001BOA"), [
    { type: "action", action: { type: "left" } },
    { type: "action", action: { type: "up" } },
  ]);
});

test("VT raw input submits ordinary text with CR", async () => {
  const { value, input, output } = await readChunks(["hello\r"]);

  assert.equal(value, "hello");
  assertTerminalRestored(input, output);
});

test("VT raw input preserves type-ahead events for the next prompt", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const history = new InputHistory();
  const first = readVtTerminalInput(history, "› ", { input, output });
  await new Promise<void>((resolve) => setImmediate(resolve));

  input.emit("data", "one\rtwo\r");

  assert.equal(await first, "one");
  assert.equal(await readVtTerminalInput(history, "› ", { input, output }), "two");
  assert.deepEqual(input.rawModes, [true, false, true, false]);
  assert.equal(input.isPaused(), true);
});

test("VT Enter keeps editing while the current draft is empty", async () => {
  const empty = await readChunks(["\rhello\r"]);

  assert.equal(empty.value, "hello");
  assert.equal(empty.output.value.includes("\nhello"), false);
});

test("VT Enter clears a whitespace-only draft without submitting it", async () => {
  const { value } = await readChunks(["   \rkept\r"]);

  assert.equal(value, "kept");
});

test("VT raw input subscribes before resuming stdin", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.resumeChunk = "ready\r";

  const value = await readVtTerminalInput(new InputHistory(), "› ", { input, output });

  assert.equal(value, "ready");
  assertTerminalRestored(input, output);
});

test("VT raw input builds multiline drafts with Ctrl+J and Alt+Enter", async () => {
  const ctrlJ = await readChunks(["hello\nworld\r"]);
  const altEnter = await readChunks(["hello\u001B", "\rworld\r"]);
  const altLf = await readChunks(["hello\u001B\nworld\r"]);

  assert.equal(ctrlJ.value, "hello\nworld");
  assert.equal(altEnter.value, "hello\nworld");
  assert.equal(altLf.value, "hello\nworld");
});

test("VT raw input reuses editor backspace, delete, and cursor movement", async () => {
  const { value } = await readChunks(["abx\u007Fc\u001B[D\u001B[3~d\r"]);

  assert.equal(value, "abd");
});

test("VT Ctrl+C clears the current draft and keeps editing", async () => {
  const { value, input, output } = await readChunks(["discard\u0003kept\r"]);

  assert.equal(value, "kept");
  assertTerminalRestored(input, output);
});

test("VT Ctrl+C exits when the current draft is empty", async () => {
  const { value, input, output } = await readChunks(["\u0003"]);

  assert.equal(value, undefined);
  assertTerminalRestored(input, output);
});

test("VT second Ctrl+C exits after the first one clears the draft", async () => {
  const { value, input, output } = await readChunks(["discard\u0003\u0003"]);

  assert.equal(value, undefined);
  assertTerminalRestored(input, output);
});

test("VT Ctrl+D exits only when the draft is empty", async () => {
  const empty = await readChunks(["\u0004"]);
  const nonEmpty = await readChunks(["kept\u0004\r"]);

  assert.equal(empty.value, undefined);
  assert.equal(nonEmpty.value, "kept");
  assertTerminalRestored(empty.input, empty.output);
  assertTerminalRestored(nonEmpty.input, nonEmpty.output);
});

test("VT stream end exits cleanly and restores terminal state", async () => {
  const active = await startInput();
  active.input.emit("end");

  assert.equal(await active.result, undefined);
  assertTerminalRestored(active.input, active.output);
});

test("VT raw input browses existing multiline history", async () => {
  const history = new InputHistory();
  history.add("first\nsecond");

  const { value } = await readChunks(["\u001B[A\r"], history);

  assert.equal(value, "first\nsecond");
});

test("VT bracketed paste preserves lines and never submits inside its payload", async () => {
  const { value, input, output } = await readChunks([
    "\u001B[200~hello\r",
    "\nworld\nthird\u001B[20",
    "1~\r",
  ]);

  assert.equal(value, "hello\nworld\nthird");
  assertTerminalRestored(input, output);
});

test("VT bracketed paste removes terminal controls and expands tabs", async () => {
  const { value } = await readChunks(["\u001B[200~a\t\u0007\u001B[2J\u009Bb\u001B[201~\r"]);

  assert.equal(value, "a    [2Jb");
});

test("VT input decoder preserves UTF-8 characters split across chunks", async () => {
  const bytes = Buffer.from("привет\r");
  const { value } = await readChunks([bytes.subarray(0, 3), bytes.subarray(3)]);

  assert.equal(value, "привет");
});

test("VT raw mode and bracketed paste are restored after an input error", async () => {
  const active = await startInput();
  const failure = new Error("input failed");
  active.input.emit("error", failure);

  await assert.rejects(active.result, failure);
  assertTerminalRestored(active.input, active.output);
});

test("VT raw mode and bracketed paste are restored after abort", async () => {
  const abort = new AbortController();
  const active = await startInput(new InputHistory(), abort.signal);
  abort.abort();

  await assert.rejects(active.result, { name: "AbortError" });
  assertTerminalRestored(active.input, active.output);
});

test("terminal backend selection uses VT for Orca and other PTY terminals", () => {
  assert.equal(
    selectTerminalInputBackend("win32", true, true, {
      TERM_PROGRAM: "Orca",
      TERM: "xterm-256color",
    }),
    "vt",
  );
  assert.equal(selectTerminalInputBackend("win32", true, true, {}), "win32");
  assert.equal(selectTerminalInputBackend("android", true, true, {}), "vt");
  assert.equal(selectTerminalInputBackend("linux", true, true, {}), "vt");
  assert.equal(selectTerminalInputBackend("darwin", true, true, {}), "vt");
});

test("terminal backend selection accepts an explicit backend override", () => {
  assert.equal(selectTerminalInputBackend("win32", true, true, { ANT_INPUT_BACKEND: "vt" }), "vt");
  assert.equal(
    selectTerminalInputBackend("win32", true, true, {
      ANT_INPUT_BACKEND: "readline",
      TERM_PROGRAM: "Orca",
    }),
    "readline",
  );
  assert.throws(
    () =>
      selectTerminalInputBackend("win32", true, true, {
        ANT_INPUT_BACKEND: "unknown",
      }),
    /Некорректный ANT_INPUT_BACKEND/u,
  );
  assert.throws(
    () => selectTerminalInputBackend("linux", true, true, { ANT_INPUT_BACKEND: "win32" }),
    /только в Windows/u,
  );
  assert.equal(
    selectTerminalInputBackend("win32", false, true, { ANT_INPUT_BACKEND: "vt" }),
    "readline",
  );
});

test("terminal backend selection falls back for redirected and dumb terminals", () => {
  assert.equal(
    selectTerminalInputBackend("win32", true, false, { TERM_PROGRAM: "Orca" }),
    "readline",
  );
  assert.equal(
    selectTerminalInputBackend("win32", false, true, { TERM_PROGRAM: "Orca" }),
    "readline",
  );
  assert.equal(selectTerminalInputBackend("linux", true, true, { TERM: "dumb" }), "readline");
});

test("custom terminal input is used for every supported TTY backend", () => {
  assert.equal(usesCustomTerminalInput("android", true, true, {}), true);
  assert.equal(usesCustomTerminalInput("win32", true, true, {}), true);
  assert.equal(usesCustomTerminalInput("linux", true, true, {}), true);
  assert.equal(usesCustomTerminalInput("darwin", true, true, {}), true);
  assert.equal(usesCustomTerminalInput("android", false, true, {}), false);
});

import { on } from "node:events";
import { stdin, stdout } from "node:process";
import type { Interface } from "node:readline/promises";

import { AndroidInputDecoder } from "./android-input.js";
import { displayWidth } from "./display-width.js";
import { InputHistory } from "./input-history.js";
import { TextEditor, type CursorPosition } from "./text-editor.js";
import {
  hasPendingKeyDownInBuffer,
  mapWindowsKeyEvent,
  type ConsoleInputAction,
  type WindowsInputRecord,
} from "./windows-console-input.js";

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;
const PEEK_INPUT_RECORDS = 64;
const ENABLE_BRACKETED_PASTE = "\u001B[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001B[?2004l";

interface TerminalInputStream extends NodeJS.EventEmitter {
  readonly isRaw?: boolean;
  isPaused(): boolean;
  pause(): this;
  resume(): this;
  setRawMode(mode: boolean): this;
}

interface TerminalOutputStream {
  readonly columns?: number;
  write(value: string): unknown;
}

export interface AndroidTerminalInputOptions {
  input?: TerminalInputStream;
  output?: TerminalOutputStream;
  signal?: AbortSignal;
}

interface InputRecordValue {
  EventType?: number;
  KeyEvent?: {
    bKeyDown?: number;
    wVirtualKeyCode?: number;
    UnicodeChar?: number;
    dwControlKeyState?: number;
  };
}

interface InputRecordBufferValue {
  Records?: InputRecordValue[];
}

async function loadWindowsConsoleApi() {
  const { ffi } = await import("win32-api");
  const KeyEventRecord = ffi.struct("AgentKeyEventRecord", {
    bKeyDown: "int32",
    wRepeatCount: "uint16",
    wVirtualKeyCode: "uint16",
    wVirtualScanCode: "uint16",
    UnicodeChar: "uint16",
    dwControlKeyState: "uint32",
  });
  const InputRecord = ffi.struct("AgentInputRecord", {
    EventType: "uint16",
    Padding: "uint16",
    KeyEvent: KeyEventRecord,
  });
  ffi.struct("AgentInputRecordBuffer", {
    Records: ffi.array(InputRecord, PEEK_INPUT_RECORDS),
  });
  const kernel32 = ffi.load("kernel32.dll");

  return {
    getStdHandle: kernel32.func("void * __stdcall GetStdHandle(int32 nStdHandle)"),
    getConsoleMode: kernel32.func(
      "int32 __stdcall GetConsoleMode(void *hConsoleHandle, _Out_ uint32 *lpMode)",
    ),
    setConsoleMode: kernel32.func(
      "int32 __stdcall SetConsoleMode(void *hConsoleHandle, uint32 dwMode)",
    ),
    readConsoleInputW: kernel32.func(
      "int32 __stdcall ReadConsoleInputW(void *hConsoleInput, _Out_ AgentInputRecord *lpBuffer, uint32 nLength, _Out_ uint32 *lpNumberOfEventsRead)",
    ),
    peekConsoleInputW: kernel32.func(
      "int32 __stdcall PeekConsoleInputW(void *hConsoleInput, _Out_ AgentInputRecordBuffer *lpBuffer, uint32 nLength, _Out_ uint32 *lpNumberOfEventsRead)",
    ),
    flushConsoleInputBuffer: kernel32.func(
      "int32 __stdcall FlushConsoleInputBuffer(void *hConsoleInput)",
    ),
  };
}

type WindowsConsoleApi = Awaited<ReturnType<typeof loadWindowsConsoleApi>>;
let windowsConsoleApi: Promise<WindowsConsoleApi> | undefined;

function getWindowsConsoleApi(): Promise<WindowsConsoleApi> {
  windowsConsoleApi ??= loadWindowsConsoleApi();
  return windowsConsoleApi;
}

export function canEraseInline(before: CursorPosition, after: CursorPosition): boolean {
  return before.row === after.row;
}

function moveCursor(
  from: CursorPosition,
  to: CursorPosition,
  output: TerminalOutputStream = stdout,
): void {
  const rows = to.row - from.row;

  if (rows === 0) {
    const columns = to.column - from.column;

    if (columns < 0) {
      output.write(`\u001B[${-columns}D`);
    } else if (columns > 0) {
      output.write(`\u001B[${columns}C`);
    }
    return;
  }

  output.write(rows < 0 ? `\u001B[${-rows}A` : `\u001B[${rows}B`);
  output.write("\r");
  if (to.column > 0) {
    output.write(`\u001B[${to.column + 1}G`);
  }
}

function redraw(
  editor: TextEditor,
  previousCursor: CursorPosition,
  prompt: string,
  output: TerminalOutputStream = stdout,
): CursorPosition {
  output.write("\u001B[?25l");

  if (previousCursor.row > 0) {
    output.write(`\u001B[${previousCursor.row}A`);
  }
  output.write("\r\u001B[J");

  const rendered = editor.render(Math.max(1, output.columns ?? 80), prompt);
  output.write(rendered.text);

  const rowsUp = rendered.end.row - rendered.cursor.row;
  if (rowsUp > 0) {
    output.write(`\u001B[${rowsUp}A`);
  }
  output.write("\r");

  if (rendered.cursor.column > 0) {
    const column = Math.min(Math.max(1, output.columns ?? 80), rendered.cursor.column + 1);
    output.write(`\u001B[${column}G`);
  }

  output.write("\u001B[?25h");
  return rendered.cursor;
}

function applyEditorAction(
  editor: TextEditor,
  action: Exclude<ConsoleInputAction, { type: "submit" | "cancel" | "ignore" }>,
  cursor: CursorPosition,
  prompt: string,
  output: TerminalOutputStream = stdout,
): CursorPosition {
  const columns = Math.max(1, output.columns ?? 80);
  const promptWidth = displayWidth(prompt);
  const cursorAtEnd = editor.cursorAtEnd;
  const renderedBefore = editor.render(columns, prompt);
  const appendAtEnd = cursorAtEnd && (action.type === "character" || action.type === "newline");
  const inlineEraseCandidate =
    cursorAtEnd &&
    action.type === "backspace" &&
    editor.characterBeforeCursor !== undefined &&
    editor.characterBeforeCursor !== "\n" &&
    renderedBefore.cursor.column > 0;
  const moveCursorOnly =
    action.type === "left" ||
    action.type === "right" ||
    action.type === "up" ||
    action.type === "down" ||
    action.type === "home" ||
    action.type === "end";
  editor.apply(action, columns, Math.min(columns, promptWidth));
  const renderedAfter = editor.render(columns, prompt);
  const eraseInline =
    inlineEraseCandidate && canEraseInline(renderedBefore.cursor, renderedAfter.cursor);

  if (appendAtEnd) {
    output.write(action.type === "character" ? action.value : "\n");
    return renderedAfter.cursor;
  }
  if (eraseInline) {
    output.write("\b \b");
    return renderedAfter.cursor;
  }
  if (moveCursorOnly) {
    moveCursor(cursor, renderedAfter.cursor, output);
    return renderedAfter.cursor;
  }
  return redraw(editor, cursor, prompt, output);
}

async function readWindowsConsoleInput(history: InputHistory, prompt: string): Promise<string> {
  const api = await getWindowsConsoleApi();
  const input = api.getStdHandle(STD_INPUT_HANDLE);

  if (!input) {
    throw new Error("Не удалось получить Windows console input handle.");
  }

  const originalMode: [number | null] = [null];
  if (!api.getConsoleMode(input, originalMode) || originalMode[0] === null) {
    throw new Error("Не удалось прочитать режим Windows console input.");
  }

  if (!api.setConsoleMode(input, originalMode[0] & ~ENABLE_PROCESSED_INPUT)) {
    throw new Error("Не удалось настроить Windows console input.");
  }

  const editor = new TextEditor();
  stdout.write(prompt);
  let cursor = editor.render(Math.max(1, stdout.columns ?? 80), prompt).cursor;

  try {
    while (true) {
      const record: InputRecordValue = {};
      const eventsRead: [number | null] = [null];
      const succeeded = api.readConsoleInputW(input, record, 1, eventsRead);

      if (!succeeded || eventsRead[0] !== 1) {
        throw new Error("ReadConsoleInputW не вернул событие ввода.");
      }

      const key = record.KeyEvent;
      let action = mapWindowsKeyEvent({
        eventType: record.EventType,
        bKeyDown: key?.bKeyDown,
        virtualKeyCode: key?.wVirtualKeyCode,
        unicodeChar: key?.UnicodeChar,
        controlKeyState: key?.dwControlKeyState,
      });

      if (action.type === "up" && (editor.value === "" || history.isBrowsing)) {
        const previous = history.previous(editor.value);

        if (previous !== undefined) {
          editor.replace(previous);
          cursor = redraw(editor, cursor, prompt);
        }
        continue;
      }

      if (action.type === "down" && history.isBrowsing) {
        const next = history.next();

        if (next !== undefined) {
          editor.replace(next);
          cursor = redraw(editor, cursor, prompt);
        }
        continue;
      }

      if (action.type === "submit") {
        const buffer: InputRecordBufferValue = {};
        const eventsPeeked: [number | null] = [null];
        const peekSucceeded = api.peekConsoleInputW(
          input,
          buffer,
          PEEK_INPUT_RECORDS,
          eventsPeeked,
        );
        const peekedCount = eventsPeeked[0] ?? 0;
        const pendingRecords: WindowsInputRecord[] = (buffer.Records ?? []).map((record) => ({
          eventType: record?.EventType,
          bKeyDown: record?.KeyEvent?.bKeyDown,
        }));

        if (peekSucceeded && hasPendingKeyDownInBuffer(pendingRecords, peekedCount)) {
          action = { type: "newline" };
        } else {
          stdout.write("\n");
          return editor.value;
        }
      }

      if (action.type === "cancel") {
        editor.replace("");
        history.reset();
        cursor = redraw(editor, cursor, prompt);
        api.flushConsoleInputBuffer(input);
        continue;
      }

      if (action.type === "ignore") {
        continue;
      }

      if (
        action.type === "character" ||
        action.type === "newline" ||
        action.type === "backspace" ||
        action.type === "delete"
      ) {
        history.reset();
      }

      cursor = applyEditorAction(editor, action, cursor, prompt);
    }
  } finally {
    api.setConsoleMode(input, originalMode[0]);
  }
}

export function usesCustomTerminalInput(platform: NodeJS.Platform, isTTY: boolean): boolean {
  return isTTY && (platform === "win32" || platform === "android");
}

export async function readAndroidTerminalInput(
  history: InputHistory,
  prompt: string,
  options: AndroidTerminalInputOptions = {},
): Promise<string> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const originalRawMode = Boolean(input.isRaw);
  const originallyPaused = input.isPaused();
  const eventsAbort = new AbortController();
  const abortEvents = () => eventsAbort.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    abortEvents();
  } else {
    options.signal?.addEventListener("abort", abortEvents, { once: true });
  }

  let rawModeChanged = false;
  let bracketedPasteEnabled = false;

  try {
    input.setRawMode(true);
    rawModeChanged = true;
    output.write(ENABLE_BRACKETED_PASTE);
    bracketedPasteEnabled = true;

    const editor = new TextEditor();
    output.write(prompt);
    let cursor = editor.render(Math.max(1, output.columns ?? 80), prompt).cursor;
    const decoder = new AndroidInputDecoder();
    const chunks = on(input, "data", {
      close: ["end", "close"],
      signal: eventsAbort.signal,
    });
    input.resume();

    for await (const [chunk] of chunks) {
      for (const event of decoder.write(Buffer.isBuffer(chunk) ? chunk : String(chunk))) {
        if (event.type === "paste") {
          history.reset();
          editor.insert(event.value);
          cursor = redraw(editor, cursor, prompt, output);
          continue;
        }

        const { action } = event;
        if (action.type === "up" && (editor.value === "" || history.isBrowsing)) {
          const previous = history.previous(editor.value);
          if (previous !== undefined) {
            editor.replace(previous);
            cursor = redraw(editor, cursor, prompt, output);
          }
          continue;
        }

        if (action.type === "down" && history.isBrowsing) {
          const next = history.next();
          if (next !== undefined) {
            editor.replace(next);
            cursor = redraw(editor, cursor, prompt, output);
          }
          continue;
        }

        if (action.type === "submit") {
          output.write("\n");
          return editor.value;
        }

        if (action.type === "cancel") {
          editor.replace("");
          history.reset();
          cursor = redraw(editor, cursor, prompt, output);
          continue;
        }

        if (action.type === "ignore") continue;

        history.reset();
        cursor = applyEditorAction(editor, action, cursor, prompt, output);
      }
    }

    throw new Error("Поток терминального ввода завершён");
  } finally {
    eventsAbort.abort();
    options.signal?.removeEventListener("abort", abortEvents);
    try {
      if (bracketedPasteEnabled) output.write(DISABLE_BRACKETED_PASTE);
    } finally {
      try {
        if (rawModeChanged) input.setRawMode(originalRawMode);
      } finally {
        if (originallyPaused) input.pause();
      }
    }
  }
}

export async function readTerminalInput(
  history: InputHistory,
  fallback?: Pick<Interface, "question">,
  prompt = "",
): Promise<string> {
  if (process.platform === "win32" && process.stdin.isTTY) {
    return readWindowsConsoleInput(history, prompt);
  }

  if (process.platform === "android" && process.stdin.isTTY) {
    return readAndroidTerminalInput(history, prompt);
  }

  if (!fallback) {
    throw new Error("Интерактивный ввод недоступен");
  }

  return fallback.question(prompt);
}

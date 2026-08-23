import { stdout } from "node:process";
import type { Interface } from "node:readline/promises";

import { InputHistory } from "./input-history.js";
import { TextEditor, type CursorPosition } from "./text-editor.js";
import { mapWindowsKeyEvent } from "./windows-console-input.js";

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

interface InputRecordValue {
  EventType?: number;
  KeyEvent?: {
    bKeyDown?: number;
    wVirtualKeyCode?: number;
    UnicodeChar?: number;
    dwControlKeyState?: number;
  };
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
  ffi.struct("AgentInputRecord", {
    EventType: "uint16",
    Padding: "uint16",
    KeyEvent: KeyEventRecord,
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
  };
}

type WindowsConsoleApi = Awaited<ReturnType<typeof loadWindowsConsoleApi>>;
let windowsConsoleApi: Promise<WindowsConsoleApi> | undefined;

function getWindowsConsoleApi(): Promise<WindowsConsoleApi> {
  windowsConsoleApi ??= loadWindowsConsoleApi();
  return windowsConsoleApi;
}

function moveCursor(from: CursorPosition, to: CursorPosition): void {
  const rows = to.row - from.row;

  if (rows === 0) {
    const columns = to.column - from.column;

    if (columns < 0) {
      stdout.write(`\u001B[${-columns}D`);
    } else if (columns > 0) {
      stdout.write(`\u001B[${columns}C`);
    }
    return;
  }

  stdout.write(rows < 0 ? `\u001B[${-rows}A` : `\u001B[${rows}B`);
  stdout.write("\r");
  if (to.column > 0) {
    stdout.write(`\u001B[${to.column + 1}G`);
  }
}

function redraw(editor: TextEditor, previousCursor: CursorPosition): CursorPosition {
  stdout.write("\u001B[?25l");

  if (previousCursor.row > 0) {
    stdout.write(`\u001B[${previousCursor.row}A`);
  }
  stdout.write("\r\u001B[J");

  const rendered = editor.render(Math.max(1, stdout.columns ?? 80));
  stdout.write(rendered.text);

  const rowsUp = rendered.end.row - rendered.cursor.row;
  if (rowsUp > 0) {
    stdout.write(`\u001B[${rowsUp}A`);
  }
  stdout.write("\r");

  if (rendered.cursor.column > 0) {
    const column = Math.min(Math.max(1, stdout.columns ?? 80), rendered.cursor.column + 1);
    stdout.write(`\u001B[${column}G`);
  }

  stdout.write("\u001B[?25h");
  return rendered.cursor;
}

async function readWindowsConsoleInput(history: InputHistory): Promise<string> {
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
  let cursor: CursorPosition = { row: 0, column: 0 };

  try {
    while (true) {
      const record: InputRecordValue = {};
      const eventsRead: [number | null] = [null];
      const succeeded = api.readConsoleInputW(input, record, 1, eventsRead);

      if (!succeeded || eventsRead[0] !== 1) {
        throw new Error("ReadConsoleInputW не вернул событие ввода.");
      }

      const key = record.KeyEvent;
      const action = mapWindowsKeyEvent({
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
          cursor = redraw(editor, cursor);
        }
        continue;
      }

      if (action.type === "down" && history.isBrowsing) {
        const next = history.next();

        if (next !== undefined) {
          editor.replace(next);
          cursor = redraw(editor, cursor);
        }
        continue;
      }

      if (action.type === "submit") {
        stdout.write("\n");
        return editor.value;
      }

      if (action.type === "cancel") {
        editor.replace("");
        history.reset();
        cursor = redraw(editor, cursor);
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

      const columns = Math.max(1, stdout.columns ?? 80);
      const cursorAtEnd = editor.cursorAtEnd;
      const renderedBefore = editor.render(columns);
      const appendAtEnd = cursorAtEnd && (action.type === "character" || action.type === "newline");
      const eraseAtEnd =
        cursorAtEnd &&
        action.type === "backspace" &&
        editor.characterBeforeCursor !== "\n" &&
        renderedBefore.cursor.column > 0;
      const moveCursorOnly =
        action.type === "left" ||
        action.type === "right" ||
        action.type === "up" ||
        action.type === "down" ||
        action.type === "home" ||
        action.type === "end";
      editor.apply(action, columns);

      if (appendAtEnd) {
        stdout.write(action.type === "character" ? action.value : "\n");
        cursor = editor.render(columns).cursor;
      } else if (eraseAtEnd) {
        stdout.write("\b \b");
        cursor = editor.render(columns).cursor;
      } else if (moveCursorOnly) {
        const nextCursor = editor.render(columns).cursor;
        moveCursor(cursor, nextCursor);
        cursor = nextCursor;
      } else {
        cursor = redraw(editor, cursor);
      }
    }
  } finally {
    api.setConsoleMode(input, originalMode[0]);
  }
}

export async function readTerminalInput(
  history: InputHistory,
  fallback?: Pick<Interface, "question">,
): Promise<string> {
  if (process.platform === "win32" && process.stdin.isTTY) {
    return readWindowsConsoleInput(history);
  }

  if (!fallback) {
    throw new Error("Интерактивный ввод недоступен");
  }

  return fallback.question("");
}

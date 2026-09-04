import { on } from "node:events";
import { stdin, stdout } from "node:process";
import type { Interface } from "node:readline/promises";

import { InputHistory } from "./input-history.js";
import {
  TerminalInputController,
  type TerminalInputResult,
  type TerminalOutputStream,
} from "./terminal-input-controller.js";
export { canEraseInline } from "./terminal-input-controller.js";
import { mapWindowsKeyEvent } from "./windows-console-input.js";
import { VtInputDecoder, type VtInputEvent } from "./vt-input.js";

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;
const ENABLE_BRACKETED_PASTE = "\u001B[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001B[?2004l";

interface VtInputState {
  readonly decoder: VtInputDecoder;
  readonly pendingEvents: VtInputEvent[];
  ended: boolean;
}

const vtInputStates = new WeakMap<TerminalInputStream, VtInputState>();

interface TerminalInputStream extends NodeJS.EventEmitter {
  readonly isRaw?: boolean;
  readonly readableFlowing?: boolean | null;
  pause(): this;
  resume(): this;
  setRawMode(mode: boolean): this;
}

export interface VtTerminalInputOptions {
  input?: TerminalInputStream;
  output?: TerminalOutputStream;
  signal?: AbortSignal;
}

export type TerminalInputBackend = "readline" | "vt" | "win32";

export interface TerminalInputEnvironment {
  readonly TERM?: string;
  readonly TERM_PROGRAM?: string;
  readonly WT_SESSION?: string;
  readonly MSYSTEM?: string;
  readonly CYGWIN?: string;
  readonly ORCA_TERMINAL_HANDLE?: string;
  readonly ANT_INPUT_BACKEND?: string;
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

async function readWindowsConsoleInput(
  history: InputHistory,
  prompt: string,
): Promise<string | undefined> {
  const api = await getWindowsConsoleApi();
  const input = api.getStdHandle(STD_INPUT_HANDLE);

  if (!input) {
    throw new Error("Не удалось получить Windows console input handle.");
  }

  const originalMode: [number | null] = [null];
  if (!api.getConsoleMode(input, originalMode) || originalMode[0] === null) {
    throw new Error("Не удалось прочитать режим Windows console input.");
  }

  const originalConsoleMode = originalMode[0];
  if (!api.setConsoleMode(input, originalConsoleMode & ~ENABLE_PROCESSED_INPUT)) {
    throw new Error("Не удалось настроить Windows console input.");
  }

  let operationFailed = false;
  let operationError: unknown;
  let resultValue: string | undefined;
  try {
    const controller = new TerminalInputController(history, prompt, stdout);
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

      const result = controller.handle({ type: "action", action });
      if (result.done) {
        resultValue = result.value;
        break;
      }
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let restored = false;
  try {
    restored = Boolean(api.setConsoleMode(input, originalConsoleMode));
  } catch (error) {
    if (!operationFailed) {
      operationFailed = true;
      operationError = error;
    }
  }
  if (operationFailed) throw operationError;
  if (!restored) {
    throw new Error("Не удалось восстановить режим Windows console input.");
  }
  return resultValue;
}

function identifiesVtTerminal(environment: TerminalInputEnvironment): boolean {
  if (
    environment.TERM_PROGRAM ||
    environment.WT_SESSION ||
    environment.MSYSTEM ||
    environment.CYGWIN ||
    environment.ORCA_TERMINAL_HANDLE
  ) {
    return true;
  }
  return /^(?:ansi|cygwin|msys|screen|tmux|vt\d+|xterm)/iu.test(environment.TERM ?? "");
}

export function selectTerminalInputBackend(
  platform: NodeJS.Platform,
  inputIsTTY: boolean,
  outputIsTTY: boolean,
  environment: TerminalInputEnvironment = process.env,
): TerminalInputBackend {
  const requestedBackend = environment.ANT_INPUT_BACKEND?.trim().toLowerCase();
  if (
    requestedBackend !== undefined &&
    requestedBackend !== "" &&
    requestedBackend !== "auto" &&
    requestedBackend !== "readline" &&
    requestedBackend !== "vt" &&
    requestedBackend !== "win32"
  ) {
    throw new Error(
      `Некорректный ANT_INPUT_BACKEND=${environment.ANT_INPUT_BACKEND}. Ожидается auto, vt, win32 или readline.`,
    );
  }
  if (requestedBackend === "win32" && platform !== "win32") {
    throw new Error("ANT_INPUT_BACKEND=win32 поддерживается только в Windows.");
  }

  if (!inputIsTTY || !outputIsTTY) return "readline";
  if (
    requestedBackend === "readline" ||
    requestedBackend === "vt" ||
    requestedBackend === "win32"
  ) {
    return requestedBackend;
  }

  if (environment.TERM === "dumb") return "readline";
  if (platform === "android") return "vt";
  if (platform === "win32") return identifiesVtTerminal(environment) ? "vt" : "win32";
  return "vt";
}

export function usesCustomTerminalInput(
  platform: NodeJS.Platform,
  inputIsTTY: boolean,
  outputIsTTY: boolean,
  environment: TerminalInputEnvironment = process.env,
): boolean {
  return selectTerminalInputBackend(platform, inputIsTTY, outputIsTTY, environment) !== "readline";
}

function getVtInputState(input: TerminalInputStream): VtInputState {
  const existing = vtInputStates.get(input);
  if (existing) return existing;

  const created: VtInputState = {
    decoder: new VtInputDecoder(),
    pendingEvents: [],
    ended: false,
  };
  vtInputStates.set(input, created);
  return created;
}

export async function readVtTerminalInput(
  history: InputHistory,
  prompt: string,
  options: VtTerminalInputOptions = {},
): Promise<string | undefined> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const originalRawMode = Boolean(input.isRaw);
  const originallyFlowing = input.readableFlowing === true;
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

    const controller = new TerminalInputController(history, prompt, output);
    const state = getVtInputState(input);
    const chunks = on(input, "data", {
      close: ["end", "close"],
      signal: eventsAbort.signal,
    });
    const handleEvents = (events: readonly VtInputEvent[]): TerminalInputResult => {
      for (let index = 0; index < events.length; index++) {
        const result = controller.handle(events[index]!);
        if (result.done) {
          state.pendingEvents.push(...events.slice(index + 1));
          return result;
        }
      }
      return { done: false };
    };

    const pendingResult = handleEvents(state.pendingEvents.splice(0));
    if (pendingResult.done) return pendingResult.value;
    if (state.ended) {
      vtInputStates.delete(input);
      output.write("\n");
      return undefined;
    }

    input.resume();
    for await (const [chunk] of chunks) {
      const events = state.decoder.write(Buffer.isBuffer(chunk) ? chunk : String(chunk));
      const result = handleEvents(events);
      if (result.done) return result.value;
    }

    state.ended = true;
    const finalResult = handleEvents(state.decoder.end());
    if (finalResult.done) return finalResult.value;
    vtInputStates.delete(input);
    output.write("\n");
    return undefined;
  } catch (error) {
    vtInputStates.delete(input);
    throw error;
  } finally {
    eventsAbort.abort();
    options.signal?.removeEventListener("abort", abortEvents);
    try {
      if (bracketedPasteEnabled) output.write(DISABLE_BRACKETED_PASTE);
    } finally {
      try {
        if (rawModeChanged) input.setRawMode(originalRawMode);
      } finally {
        if (!originallyFlowing) input.pause();
      }
    }
  }
}

export async function readTerminalInput(
  history: InputHistory,
  fallback?: Pick<Interface, "question">,
  prompt = "",
): Promise<string | undefined> {
  const backend = selectTerminalInputBackend(
    process.platform,
    Boolean(process.stdin.isTTY),
    Boolean(process.stdout.isTTY),
    process.env,
  );
  if (backend === "win32") return readWindowsConsoleInput(history, prompt);
  if (backend === "vt") return readVtTerminalInput(history, prompt);

  if (!fallback) {
    throw new Error("Интерактивный ввод недоступен");
  }

  return fallback.question(prompt);
}

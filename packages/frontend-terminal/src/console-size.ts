import { stdin, stdout } from "node:process";

import { selectTerminalInputBackend } from "./terminal-input.js";

const STD_OUTPUT_HANDLE = -11;

let resolveWidth: (() => number) | undefined;

async function initWindowsConsoleWidth(): Promise<() => number> {
  const { ffi } = await import("win32-api");

  const Coord = ffi.struct("AntConsoleCoord", {
    X: "int16",
    Y: "int16",
  });
  const SmallRect = ffi.struct("AntConsoleSmallRect", {
    Left: "int16",
    Top: "int16",
    Right: "int16",
    Bottom: "int16",
  });
  ffi.struct("AntScreenBufferInfo", {
    dwSize: Coord,
    dwCursorPosition: Coord,
    wAttributes: "uint16",
    srWindow: SmallRect,
    dwMaximumWindowSize: Coord,
  });

  const kernel32 = ffi.load("kernel32.dll");
  const getStdHandle = kernel32.func("void * __stdcall GetStdHandle(int32 nStdHandle)");
  const getConsoleScreenBufferInfo = kernel32.func(
    "int32 __stdcall GetConsoleScreenBufferInfo(void *hConsoleOutput, _Out_ AntScreenBufferInfo *lpConsoleScreenBufferInfo)",
  );
  const output = getStdHandle(STD_OUTPUT_HANDLE);

  return () => {
    const info: { srWindow?: { Left?: number; Right?: number } } = {};
    if (output && getConsoleScreenBufferInfo(output, info)) {
      const left = info.srWindow?.Left ?? 0;
      const right = info.srWindow?.Right ?? 0;
      const width = right - left + 1;
      if (width > 0) {
        return width;
      }
    }
    return stdout.columns ?? 80;
  };
}

export async function initConsoleSize(): Promise<void> {
  const backend = selectTerminalInputBackend(
    process.platform,
    Boolean(stdin.isTTY),
    Boolean(stdout.isTTY),
  );
  resolveWidth = backend === "win32" ? await initWindowsConsoleWidth() : () => stdout.columns ?? 80;
}

export function consoleWidth(): number {
  const width = resolveWidth ? resolveWidth() : (stdout.columns ?? 80);
  return Math.max(1, width);
}

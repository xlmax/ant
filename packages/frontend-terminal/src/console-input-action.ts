export type ConsoleInputAction =
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "eof" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "character"; value: string }
  | { type: "ignore" };

export type TerminalInputEvent =
  { type: "action"; action: ConsoleInputAction } | { type: "paste"; value: string };

export function isPrintableCodePoint(codePoint: number): boolean {
  return codePoint >= 32 && codePoint !== 127 && (codePoint < 128 || codePoint > 159);
}

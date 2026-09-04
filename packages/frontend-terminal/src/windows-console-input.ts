import { isPrintableCodePoint, type ConsoleInputAction } from "./console-input-action.js";

export const KEY_EVENT = 0x0001;
export const VK_BACK = 0x08;
export const VK_RETURN = 0x0d;
export const VK_END = 0x23;
export const VK_HOME = 0x24;
export const VK_LEFT = 0x25;
export const VK_UP = 0x26;
export const VK_RIGHT = 0x27;
export const VK_DOWN = 0x28;
export const VK_DELETE = 0x2e;
export const RIGHT_ALT_PRESSED = 0x0001;
export const LEFT_ALT_PRESSED = 0x0002;
export const RIGHT_CTRL_PRESSED = 0x0004;
export const LEFT_CTRL_PRESSED = 0x0008;
export const SHIFT_PRESSED = 0x0010;

const NEWLINE_MODIFIERS =
  RIGHT_ALT_PRESSED | LEFT_ALT_PRESSED | RIGHT_CTRL_PRESSED | LEFT_CTRL_PRESSED | SHIFT_PRESSED;

export interface WindowsKeyEvent {
  eventType?: number | undefined;
  bKeyDown?: number | undefined;
  virtualKeyCode?: number | undefined;
  unicodeChar?: number | undefined;
  controlKeyState?: number | undefined;
}

export function mapWindowsKeyEvent(event: WindowsKeyEvent): ConsoleInputAction {
  if (event.eventType !== KEY_EVENT || !event.bKeyDown) {
    return { type: "ignore" };
  }

  if (event.unicodeChar === 3) {
    return { type: "cancel" };
  }
  if (event.unicodeChar === 10) {
    return { type: "newline" };
  }
  if (event.unicodeChar === 4) {
    return { type: "eof" };
  }

  switch (event.virtualKeyCode) {
    case VK_RETURN:
      return (event.controlKeyState ?? 0) & NEWLINE_MODIFIERS
        ? { type: "newline" }
        : { type: "submit" };
    case VK_BACK:
      return { type: "backspace" };
    case VK_DELETE:
      return { type: "delete" };
    case VK_LEFT:
      return { type: "left" };
    case VK_RIGHT:
      return { type: "right" };
    case VK_UP:
      return { type: "up" };
    case VK_DOWN:
      return { type: "down" };
    case VK_HOME:
      return { type: "home" };
    case VK_END:
      return { type: "end" };
    default: {
      const unicodeChar = event.unicodeChar ?? 0;
      return isPrintableCodePoint(unicodeChar)
        ? { type: "character", value: String.fromCharCode(unicodeChar) }
        : { type: "ignore" };
    }
  }
}

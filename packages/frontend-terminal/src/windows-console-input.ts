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
export const SHIFT_PRESSED = 0x0010;

export interface WindowsKeyEvent {
  eventType?: number | undefined;
  bKeyDown?: number | undefined;
  virtualKeyCode?: number | undefined;
  unicodeChar?: number | undefined;
  controlKeyState?: number | undefined;
}

export interface WindowsInputRecord {
  eventType?: number | undefined;
  bKeyDown?: number | undefined;
}

export type ConsoleInputAction =
  | { type: "submit" }
  | { type: "cancel" }
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

export function hasPendingKeyDown(record: WindowsInputRecord | undefined): boolean {
  return record?.eventType === KEY_EVENT && Boolean(record.bKeyDown);
}

export function hasPendingKeyDownInBuffer(
  records: readonly WindowsInputRecord[],
  count: number,
): boolean {
  const limit = Math.min(count, records.length);
  for (let index = 0; index < limit; index++) {
    if (hasPendingKeyDown(records[index])) {
      return true;
    }
  }
  return false;
}

export function mapWindowsKeyEvent(event: WindowsKeyEvent): ConsoleInputAction {
  if (event.eventType !== KEY_EVENT || !event.bKeyDown) {
    return { type: "ignore" };
  }

  if (event.unicodeChar === 3) {
    return { type: "cancel" };
  }

  switch (event.virtualKeyCode) {
    case VK_RETURN:
      return (event.controlKeyState ?? 0) & SHIFT_PRESSED
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
      return unicodeChar >= 32
        ? { type: "character", value: String.fromCharCode(unicodeChar) }
        : { type: "ignore" };
    }
  }
}

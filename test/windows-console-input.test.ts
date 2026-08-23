import assert from "node:assert/strict";
import test from "node:test";

import {
  KEY_EVENT,
  SHIFT_PRESSED,
  VK_RETURN,
  mapWindowsKeyEvent,
} from "../src/ui/windows-console-input.js";

test("Windows console input maps Shift+Enter to a newline", () => {
  assert.deepEqual(
    mapWindowsKeyEvent({
      eventType: KEY_EVENT,
      bKeyDown: 1,
      virtualKeyCode: VK_RETURN,
      controlKeyState: SHIFT_PRESSED,
    }),
    { type: "newline" },
  );
});

test("Windows console input maps Enter to submit", () => {
  assert.deepEqual(
    mapWindowsKeyEvent({
      eventType: KEY_EVENT,
      bKeyDown: 1,
      virtualKeyCode: VK_RETURN,
      controlKeyState: 0,
    }),
    { type: "submit" },
  );
});

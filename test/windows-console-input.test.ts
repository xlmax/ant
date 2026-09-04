import assert from "node:assert/strict";
import test from "node:test";

import {
  KEY_EVENT,
  LEFT_ALT_PRESSED,
  LEFT_CTRL_PRESSED,
  RIGHT_ALT_PRESSED,
  RIGHT_CTRL_PRESSED,
  SHIFT_PRESSED,
  VK_RETURN,
  mapWindowsKeyEvent,
} from "../packages/frontend-terminal/src/windows-console-input.js";

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

test("Windows console input maps Ctrl+D to EOF", () => {
  assert.deepEqual(
    mapWindowsKeyEvent({
      eventType: KEY_EVENT,
      bKeyDown: 1,
      virtualKeyCode: 0x44,
      unicodeChar: 4,
      controlKeyState: LEFT_CTRL_PRESSED,
    }),
    { type: "eof" },
  );
});

test("Windows console input maps Ctrl+J to a newline", () => {
  assert.deepEqual(
    mapWindowsKeyEvent({
      eventType: KEY_EVENT,
      bKeyDown: 1,
      virtualKeyCode: 0x4a,
      unicodeChar: 10,
      controlKeyState: LEFT_CTRL_PRESSED,
    }),
    { type: "newline" },
  );
});

test("Windows console input maps modified Enter to a newline", () => {
  for (const modifier of [
    LEFT_CTRL_PRESSED,
    RIGHT_CTRL_PRESSED,
    LEFT_ALT_PRESSED,
    RIGHT_ALT_PRESSED,
  ]) {
    assert.deepEqual(
      mapWindowsKeyEvent({
        eventType: KEY_EVENT,
        bKeyDown: 1,
        virtualKeyCode: VK_RETURN,
        controlKeyState: modifier,
      }),
      { type: "newline" },
    );
  }
});

test("Windows console input ignores C1 control characters", () => {
  assert.deepEqual(
    mapWindowsKeyEvent({
      eventType: KEY_EVENT,
      bKeyDown: 1,
      virtualKeyCode: 0,
      unicodeChar: 0x9b,
      controlKeyState: 0,
    }),
    { type: "ignore" },
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  KEY_EVENT,
  SHIFT_PRESSED,
  VK_RETURN,
  hasPendingKeyDown,
  hasPendingKeyDownInBuffer,
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

test("Windows console input does not treat a key-up record as pasted input", () => {
  assert.equal(hasPendingKeyDown({ eventType: KEY_EVENT, bKeyDown: 0 }), false);
});

test("Windows console input treats the next key-down as pending pasted input", () => {
  assert.equal(hasPendingKeyDown({ eventType: KEY_EVENT, bKeyDown: 1 }), true);
});

test("Windows console input finds a pending key-down beyond a key-up record", () => {
  assert.equal(
    hasPendingKeyDownInBuffer(
      [
        { eventType: KEY_EVENT, bKeyDown: 0 },
        { eventType: KEY_EVENT, bKeyDown: 1 },
      ],
      2,
    ),
    true,
  );
});

test("Windows console input ignores trailing key-up records when no key-down is pending", () => {
  assert.equal(hasPendingKeyDownInBuffer([{ eventType: KEY_EVENT, bKeyDown: 0 }], 1), false);
});

test("Windows console input ignores an empty peek buffer", () => {
  assert.equal(hasPendingKeyDownInBuffer([], 0), false);
});

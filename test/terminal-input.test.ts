import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../src/ui/ansi.js";
import { userInputPrompt } from "../src/ui/input-frame.js";
import { InputHistory } from "../src/ui/input-history.js";
import { canEraseInline, readTerminalInput } from "../src/ui/terminal-input.js";
import { TextEditor } from "../src/ui/text-editor.js";

test("terminal input redraws when backspace crosses an automatic wrap", () => {
  const editor = new TextEditor();
  editor.replace("abcd");
  const before = editor.render(5, "› ").cursor;

  editor.apply({ type: "backspace" }, 5, 2);
  const after = editor.render(5, "› ").cursor;

  assert.deepEqual(before, { row: 1, column: 1 });
  assert.deepEqual(after, { row: 0, column: 5 });
  assert.equal(canEraseInline(before, after), false);

  editor.apply({ type: "backspace" }, 5, 2);
  const sameRow = editor.render(5, "› ").cursor;
  assert.equal(canEraseInline(after, sameRow), true);
});

test("terminal input renders the user marker as its prompt", async () => {
  configureAnsi(false);

  try {
    const prompt = userInputPrompt();
    const input = await readTerminalInput(
      new InputHistory(),
      {
        question: async (query: string) => {
          assert.equal(query, "› ");
          return "сообщение";
        },
      },
      prompt,
    );

    assert.equal(input, "сообщение");
  } finally {
    configureAnsi(true);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { TextEditor } from "../src/ui/text-editor.js";

test("backspace joins lines and keeps the cursor at the previous line end", () => {
  const editor = new TextEditor();

  for (const value of ["п", "е", "р", "в", "а", "я"]) {
    editor.apply({ type: "character", value }, 80);
  }
  editor.apply({ type: "newline" }, 80);
  for (const value of ["в", "т", "о", "р", "а", "я"]) {
    editor.apply({ type: "character", value }, 80);
  }

  for (let index = 0; index < 7; index += 1) {
    editor.apply({ type: "backspace" }, 80);
  }

  assert.equal(editor.value, "первая");
  editor.apply({ type: "character", value: "!" }, 80);
  assert.equal(editor.value, "первая!");
});

test("arrow keys and delete edit the buffer at the cursor", () => {
  const editor = new TextEditor();

  for (const value of ["a", "b", "c"]) {
    editor.apply({ type: "character", value }, 80);
  }
  editor.apply({ type: "left" }, 80);
  editor.apply({ type: "delete" }, 80);

  assert.equal(editor.value, "ab");
});

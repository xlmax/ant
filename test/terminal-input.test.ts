import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../packages/frontend-terminal/src/ansi.js";
import { userInputPrompt } from "../packages/frontend-terminal/src/input-frame.js";
import { InputHistory } from "../packages/frontend-terminal/src/input-history.js";
import { TerminalInputController } from "../packages/frontend-terminal/src/terminal-input-controller.js";
import {
  canEraseInline,
  readTerminalInput,
} from "../packages/frontend-terminal/src/terminal-input.js";
import { TextEditor } from "../packages/frontend-terminal/src/text-editor.js";

class FakeOutput {
  readonly columns = 10;
  value = "";
  readonly writes: string[] = [];

  write(value: string): void {
    this.value += value;
    this.writes.push(value);
  }
}

test("terminal input redraws when backspace crosses the right edge", () => {
  const editor = new TextEditor();
  editor.replace("abcdefgh");
  const before = editor.render(10, "› ").cursor;

  editor.apply({ type: "backspace" }, 10, 2);
  const after = editor.render(10, "› ").cursor;

  assert.deepEqual(before, { row: 1, column: 0 });
  assert.deepEqual(after, { row: 0, column: 9 });
  assert.equal(canEraseInline(before, after), false);

  editor.apply({ type: "backspace" }, 10, 2);
  const sameRow = editor.render(10, "› ").cursor;
  assert.equal(canEraseInline(after, sameRow), true);
});

test("terminal input controller redraws instead of inline erasing at the edge", () => {
  const output = new FakeOutput();
  const controller = new TerminalInputController(new InputHistory(), "› ", output);

  for (const value of "abcdefgh") {
    controller.handle({
      type: "action",
      action: { type: "character", value },
    });
  }

  const writesBeforeBackspace = output.writes.length;
  controller.handle({ type: "action", action: { type: "backspace" } });
  const backspaceWrites = output.writes.slice(writesBeforeBackspace).join("");

  assert.equal(controller.value, "abcdefg");
  assert.equal(backspaceWrites.includes("\b \b"), false);
  assert.equal(backspaceWrites.includes("\u001B[?25l"), true);

  const writesBeforeRetype = output.writes.length;
  controller.handle({
    type: "action",
    action: { type: "character", value: "i" },
  });
  const retypeWrites = output.writes.slice(writesBeforeRetype).join("");

  assert.equal(controller.value, "abcdefgi");
  assert.equal(retypeWrites.includes("\b \b"), false);
  assert.equal(retypeWrites.endsWith("i"), true);
});

test("terminal input controller applies the same cancel contract for every backend", () => {
  const output = {
    columns: 80,
    value: "",
    write(value: string) {
      this.value += value;
    },
  };
  const controller = new TerminalInputController(new InputHistory(), "› ", output);

  assert.deepEqual(
    controller.handle({
      type: "action",
      action: { type: "character", value: "черновик" },
    }),
    { done: false },
  );
  assert.deepEqual(controller.handle({ type: "action", action: { type: "cancel" } }), {
    done: false,
  });
  assert.equal(controller.value, "");
  assert.deepEqual(controller.handle({ type: "action", action: { type: "cancel" } }), {
    done: true,
    value: undefined,
  });
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

import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../src/ui/ansi.js";
import { userInputPrompt } from "../src/ui/input-frame.js";
import { InputHistory } from "../src/ui/input-history.js";
import { readTerminalInput } from "../src/ui/terminal-input.js";

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

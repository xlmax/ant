import assert from "node:assert/strict";
import test from "node:test";

import { configureAnsi } from "../src/ui/ansi.js";
import { closeUserInputFrame, openUserInputFrame, userInputPrompt } from "../src/ui/input-frame.js";

const VIOLET = `${String.fromCharCode(27)}[38;2;155;138;251m`;

test("user input uses violet boundaries and a matching prompt marker", () => {
  const originalWrite = process.stdout.write;
  const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const output: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  configureAnsi(true);

  try {
    openUserInputFrame();
    const prompt = userInputPrompt();
    closeUserInputFrame();

    assert.ok(output[0]?.startsWith(VIOLET));
    assert.ok(output[1]?.startsWith(VIOLET));
    assert.ok(prompt.startsWith(VIOLET));
    assert.match(prompt, /› /u);
    assert.doesNotMatch(output.join(""), /Вы/u);
  } finally {
    process.stdout.write = originalWrite;
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", isTTYDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    configureAnsi(true);
  }
});

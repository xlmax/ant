import assert from "node:assert/strict";
import test from "node:test";

import { TypingPump } from "../src/ui/typing-pump.js";

const CURSOR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[\\?25[hl]`, "gu");

test("typing pump drains text naturally and preserves ANSI and graphemes", async () => {
  const writes: string[] = [];
  const styled = `\x1b[2m${"😀".repeat(12)}\x1b[0m`;
  const pump = new TypingPump({
    write: (text) => writes.push(text),
    interactive: () => true,
  });

  pump.push(styled);
  pump.pushInstant("<footer>");
  await pump.whenIdle();

  const rendered = writes.join("").replace(CURSOR_PATTERN, "");
  assert.equal(rendered, `${styled}<footer>`);
  assert.doesNotMatch(rendered, /�/u);
  assert.ok(writes.length >= 4, "text should be emitted over more than one timer tick");
});

test("live tool line waits for typed output and owns cursor updates exclusively", async () => {
  const writes: string[] = [];
  const typed = "reasoning ".repeat(3);
  const pump = new TypingPump({
    write: (text) => writes.push(text),
    interactive: () => true,
  });

  pump.push(typed);
  const entered = pump.enterLiveMode();
  pump.updateLiveLine("too early");
  await entered;
  pump.writeLiveLine("→ bash npm test");
  pump.updateLiveLine("⠋ bash · 100 ms");
  pump.writeLiveLine("✓ bash exit 0 · 200 ms");
  pump.leaveLiveMode();

  const rendered = writes.join("");
  assert.ok(rendered.indexOf(typed) < rendered.indexOf("→ bash npm test"));
  assert.doesNotMatch(rendered, /too early/u);
  assert.match(rendered, /⠋ bash · 100 ms/u);
  assert.match(rendered, /✓ bash exit 0 · 200 ms/u);
  assert.ok(rendered.endsWith("\x1b[?25h"));
});

test("cancelling the pump discards queued text and restores the cursor", () => {
  const writes: string[] = [];
  const pump = new TypingPump({
    write: (text) => writes.push(text),
    interactive: () => true,
  });

  pump.push("queued output that must not be printed");
  pump.cancel();

  const rendered = writes.join("");
  assert.doesNotMatch(rendered, /queued output/u);
  assert.equal(rendered, "\x1b[?25l\x1b[0m\x1b[?25h");
});

test("cancelling while live mode waits does not reacquire the terminal", async () => {
  const writes: string[] = [];
  const pump = new TypingPump({
    write: (text) => writes.push(text),
    interactive: () => true,
  });

  pump.push("a long queued line that is still waiting to be typed");
  const entering = pump.enterLiveMode();
  pump.cancel();
  await entering;
  pump.updateLiveLine("must not appear");

  const rendered = writes.join("");
  assert.equal(rendered, "\x1b[?25l\x1b[0m\x1b[?25h");
});

test("non-interactive output is synchronous and emits no cursor controls", async () => {
  const writes: string[] = [];
  const pump = new TypingPump({
    write: (text) => writes.push(text),
    interactive: () => false,
  });

  pump.push("typed");
  pump.pushInstant("<footer>");
  assert.equal(writes.join(""), "typed<footer>");
  await pump.enterLiveMode();
  pump.writeLiveLine("→ bash");
  pump.updateLiveLine("spinner");
  pump.writeLiveLine("✓ bash");
  pump.leaveLiveMode();

  assert.equal(writes.join(""), "typed<footer>→ bash\n✓ bash\n");
  assert.ok(!writes.join("").includes(String.fromCharCode(27)));
});

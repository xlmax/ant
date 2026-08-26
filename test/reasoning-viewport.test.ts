import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningViewport } from "../src/ui/reasoning-viewport.js";

function append(viewport: ReasoningViewport, text: string): void {
  for (const character of Array.from(text)) {
    viewport.append({
      text: character,
      width: character === "\n" ? 0 : 1,
      lineBreak: character === "\n",
    });
  }
}

test("reasoning viewport grows and retains only its last rows", () => {
  const viewport = new ReasoningViewport({
    maxRows: 3,
    width: () => 20,
    frame: () => "────",
    styleRow: (text) => text,
  });

  append(viewport, "первая\nвторая\nтретья\nчетвёртая");

  assert.deepEqual(viewport.visibleRows(), ["вторая", "третья", "четвёртая"]);
  const firstFrame = viewport.redraw();
  assert.match(firstFrame, /^────\nвторая\nтретья\nчетвёртая\n────$/u);

  append(viewport, "!");
  const update = viewport.redraw();
  assert.ok(update.includes(`${String.fromCharCode(27)}[3A`));
  assert.match(update, /четвёртая!/u);
  assert.equal(viewport.finish(), "\n");
});

test("reasoning viewport wraps wide content into terminal rows", () => {
  const viewport = new ReasoningViewport({
    maxRows: 4,
    width: () => 5,
    frame: () => "─────",
    styleRow: (text) => text,
  });

  append(viewport, "123456789");

  assert.deepEqual(viewport.visibleRows(), ["12345", "6789"]);
});

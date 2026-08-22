import assert from "node:assert/strict";
import test from "node:test";

import { sectionFooter, sectionHeader } from "../src/ui/section.js";

test("section headers use horizontal separators", () => {
  const header = sectionHeader("Вы", (text) => text);

  const plainHeader = header.replace(/\u001B\[\d+m/gu, "");
  const plainFooter = sectionFooter().replace(/\u001B\[\d+m/gu, "");

  assert.match(plainHeader, /^───Вы─/u);
  assert.equal(plainHeader.length, plainFooter.length);
});

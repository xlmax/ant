import assert from "node:assert/strict";
import test from "node:test";

import { sectionFooter, sectionHeader } from "../src/ui/section.js";

test("section headers use horizontal separators", () => {
  const header = sectionHeader("Вы", (text) => text);

  const ansiSgr = new RegExp(String.raw`\u001B\[\d+m`, "gu");
  const plainHeader = header.replace(ansiSgr, "");
  const plainFooter = sectionFooter().replace(ansiSgr, "");

  assert.match(plainHeader, /^───Вы─/u);
  assert.equal(plainHeader.length, plainFooter.length);
});

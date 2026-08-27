import { stdout } from "node:process";

import { ansi } from "./ansi.js";
import { sectionFooter } from "./section.js";

export function openUserInputFrame(): void {
  stdout.write(`${sectionFooter(ansi.violet)}\n`);
}

export function userInputPrompt(): string {
  return ansi.violet(ansi.bold("› "));
}

export function closeUserInputFrame(): void {
  stdout.write(`${sectionFooter(ansi.violet)}\n`);
}

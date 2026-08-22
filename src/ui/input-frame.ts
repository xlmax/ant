import { stdout } from "node:process";

import { ansi } from "./ansi.js";
import { sectionFooter, sectionHeader } from "./section.js";

export function openUserInputFrame(): void {
  stdout.write(`${sectionHeader("Вы", (text) => ansi.bold(ansi.cyan(text)))}\n`);
}

export function userInputPrompt(): string {
  return "";
}

export function closeUserInputFrame(): void {
  stdout.write(`${sectionFooter()}\n`);
}

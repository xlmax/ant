import { ansi } from "./ansi.js";
import { displayWidth } from "./display-width.js";

function lineWidth(): number {
  return Math.max(1, process.stdout.columns ?? 80);
}

export function sectionHeader(title: string, style: (text: string) => string): string {
  const prefix = `───${title}`;
  return `${ansi.dim("───")}${style(title)}${ansi.dim(
    "─".repeat(Math.max(1, lineWidth() - displayWidth(prefix))),
  )}`;
}

export function sectionFooter(): string {
  return ansi.dim("─".repeat(lineWidth()));
}

import { ansi } from "./ansi.js";
import { displayWidth } from "./display-width.js";

function lineWidth(): number {
  return Math.max(1, process.stdout.columns ?? 80);
}

export function sectionHeader(
  title: string,
  titleStyle: (text: string) => string,
  lineStyle: (text: string) => string = ansi.dim,
): string {
  const prefix = `───${title}`;
  return `${lineStyle("───")}${titleStyle(title)}${lineStyle(
    "─".repeat(Math.max(1, lineWidth() - displayWidth(prefix))),
  )}`;
}

export function sectionFooter(style: (text: string) => string = ansi.dim): string {
  return style("─".repeat(lineWidth()));
}

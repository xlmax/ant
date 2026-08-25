import { ansi } from "./ansi.js";
import { consoleWidth } from "./console-size.js";
import { displayWidth } from "./display-width.js";

export function sectionHeader(
  title: string,
  titleStyle: (text: string) => string,
  lineStyle: (text: string) => string = ansi.dim,
): string {
  const prefix = `───${title}`;
  return `${lineStyle("───")}${titleStyle(title)}${lineStyle(
    "─".repeat(Math.max(1, consoleWidth() - displayWidth(prefix))),
  )}`;
}

export function sectionFooter(style: (text: string) => string = ansi.dim): string {
  return style("─".repeat(consoleWidth()));
}

import type { ReasoningDisplayMode } from "@ant/app";
import type { HistoryEvent, ToolCall } from "@ant/core";

import { ansi } from "./ansi.js";
import { userInputPrompt } from "./input-frame.js";
import { StreamingMarkdownRenderer } from "./markdown.js";
import { sectionFooter, sectionHeader } from "./section.js";
import { formatReplayToolStatus, formatToolLabel } from "./turn-formatters.js";

export interface ResumeReplayOptions {
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
}

function renderMarkdown(text: string): string {
  const renderer = new StreamingMarkdownRenderer();
  return `${renderer.push(text)}${renderer.finish()}`;
}

function formatUserMessage(content: string): string {
  const lines = content.split(/\r?\n/u);
  const prompt = userInputPrompt();
  if (lines.length === 0) return prompt;
  if (lines.length === 1) return `${prompt}${lines[0] ?? ""}`;
  return [`${prompt}${lines[0] ?? ""}`, ...lines.slice(1).map((line) => `  ${line}`)].join("\n");
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(lines.length - maxLines).join("\n");
}

function formatReasoningBlock(reasoning: string, options: ResumeReplayOptions): string | undefined {
  if (options.reasoningMode === "off" || reasoning.trim() === "") return undefined;

  const rendered = renderMarkdown(reasoning);
  const body =
    options.reasoningMode === "compact" ? tailLines(rendered, options.reasoningMaxLines) : rendered;
  if (body.trim() === "") return undefined;

  return [sectionFooter(), ansi.dimPreservingStyles(body), sectionFooter()].join("\n");
}

function formatAnswerBlock(answer: string): string {
  const renderer = new StreamingMarkdownRenderer();
  const rendered = `${renderer.push(answer)}${renderer.finish()}`;
  return [
    sectionHeader("Ant", (title) => ansi.bold(ansi.green(title)), ansi.green),
    rendered,
    sectionFooter(ansi.green),
  ].join("\n");
}

function formatToolStart(call: ToolCall): string {
  const label = formatToolLabel(call.name, call.input);
  const header = `${ansi.yellow("→")} ${ansi.bold(ansi.cyan(call.name))}`;
  return label === "" ? header : `${header} ${ansi.dim(label)}`;
}

function extractLastTurn(events: readonly HistoryEvent[]): readonly HistoryEvent[] | undefined {
  if (events.length === 0) return undefined;

  let end = events.length;
  while (end > 0 && events[end - 1]?.type === "compaction") {
    end -= 1;
  }
  if (end === 0) return undefined;

  let start = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "task" || event?.type === "user") {
      start = index;
      break;
    }
  }
  if (start === -1) return undefined;

  return events.slice(start, end);
}

export function formatResumeReplay(
  events: readonly HistoryEvent[] | undefined,
  options: ResumeReplayOptions,
): string {
  if (events === undefined) {
    return `${ansi.dim("Нет истории для показа")}\n`;
  }

  const turn = extractLastTurn(events);
  if (!turn) {
    return `${ansi.dim("Нет истории для показа")}\n`;
  }

  const output: string[] = [];
  let answer: string | undefined;

  for (const event of turn) {
    switch (event.type) {
      case "task":
      case "user":
        output.push(formatUserMessage(event.content));
        break;

      case "decision":
        if (event.decision.reasoning) {
          const reasoning = formatReasoningBlock(event.decision.reasoning, options);
          if (reasoning) output.push(reasoning);
        }
        if (event.decision.type === "tools") {
          output.push(...event.decision.calls.map((call) => formatToolStart(call)));
        } else {
          answer = event.decision.answer;
        }
        break;

      case "observation":
        output.push(formatReplayToolStatus(event.call, event.observation));
        break;

      case "verification":
        output.push(
          ansi.yellow(
            `⚠ Самопроверка (${event.round}/${event.maxRounds}): ответ не прошёл гейт, ход продолжается на доработку.`,
          ),
        );
        break;

      case "compaction":
        break;
    }
  }

  if (answer !== undefined) {
    output.push(formatAnswerBlock(answer));
  } else {
    output.push(ansi.dim("Ход был прерван"));
  }

  return `${output.join("\n")}\n`;
}

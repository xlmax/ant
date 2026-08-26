import type {
  AgentEvent,
  AgentObserver,
  AgentResult,
  ModelUsage,
  Observation,
  ToolCall,
} from "../core/agent.js";
import { ansi } from "./ansi.js";
import { renderInlineMarkdown, StreamingMarkdownRenderer } from "./markdown.js";
import { sectionFooter, sectionHeader } from "./section.js";
import { formatTurnChangeSummary, type TurnChangeSummary } from "./turn-change-summary.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const TOOL_LABEL_MAX_CHARS = 60;
const ERROR_REASON_MAX_CHARS = 120;
const REASONING_MARKER = "◌";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function singleLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return "";
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function formatReasoningTail(buffer: string, maxChars: number): string {
  const lines = buffer.split("\n").filter((line) => line.trim() !== "");
  return singleLine(lines[lines.length - 1] ?? "", maxChars);
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function formatToolLabel(name: string, input: unknown): string {
  const record = typeof input === "object" && input !== null ? input : undefined;
  switch (name) {
    case "bash":
      return singleLine(stringProperty(record, "command") ?? "", TOOL_LABEL_MAX_CHARS);
    case "grep":
    case "glob":
      return singleLine(stringProperty(record, "pattern") ?? "", TOOL_LABEL_MAX_CHARS);
    case "read":
    case "write":
    case "edit":
      return singleLine(stringProperty(record, "path") ?? "", TOOL_LABEL_MAX_CHARS);
    default:
      return singleLine(formatValue(input), TOOL_LABEL_MAX_CHARS);
  }
}

function bashExitCode(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("exitCode" in value)) return undefined;
  const exitCode = (value as Record<string, unknown>).exitCode;
  return typeof exitCode === "number" ? exitCode : undefined;
}

interface ToolResultLine {
  text: string;
  failed: boolean;
}

function formatToolResult(
  call: ToolCall,
  observation: Observation,
  durationMs: number,
): ToolResultLine {
  const duration = `· ${formatDuration(durationMs)}`;
  if (!observation.ok) {
    const reason = singleLine(observation.error ?? "ошибка", ERROR_REASON_MAX_CHARS);
    return { text: `${call.name} ${duration} — ${reason}`, failed: true };
  }

  const exitCode = bashExitCode(observation.value);
  if (exitCode !== undefined && exitCode !== 0) {
    return { text: `${call.name} exit ${exitCode} ${duration}`, failed: true };
  }

  const status = exitCode === 0 ? " exit 0" : "";
  return { text: `${call.name}${status} ${duration}`, failed: false };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }

  return String(tokens);
}

function formatUsage(usage: ModelUsage): string {
  const percentage = (usage.totalTokens / usage.contextWindow) * 100;
  const segments = 10;
  const filled = Math.min(segments, Math.max(percentage > 0 ? 1 : 0, Math.round(percentage / 10)));
  const meter = `${"●".repeat(filled)}${"○".repeat(segments - filled)}`;
  const statistics = `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}  ${meter} ${percentage.toFixed(1)}%`;
  const model = `(${usage.provider}) ${usage.model} · ${usage.reasoning}`;
  const width = process.stdout.columns ?? 80;

  if (statistics.length + model.length + 2 > width) {
    return `${statistics} · ${model}`;
  }

  return `${statistics}${" ".repeat(width - statistics.length - model.length)}${model}`;
}

export class ConsoleRenderer implements AgentObserver {
  #showReasoning: boolean;
  #streamedText = false;
  #streamedReasoningForDecision = false;
  #reasoningLineVisible = false;
  #reasoningBuffer = "";
  #markdown = new StreamingMarkdownRenderer();
  #usage: ModelUsage | undefined;
  readonly #finishedToolCalls = new Set<string>();
  #activeTools = new Map<string, { name: string; startedAt: number }>();
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #spinnerFrame = 0;
  #spinnerLineVisible = false;
  #hadTools = false;
  #toolGroupPendingSeparator = false;

  constructor(options: { showReasoning?: boolean } = {}) {
    this.#showReasoning = options.showReasoning ?? false;
  }

  get showReasoning(): boolean {
    return this.#showReasoning;
  }

  setShowReasoning(showReasoning: boolean): void {
    this.#showReasoning = showReasoning;
  }

  beginTurn(): void {
    this.#finalizeSpinner();
    this.#activeTools.clear();
    this.#spinnerFrame = 0;
    this.#streamedText = false;
    this.#streamedReasoningForDecision = false;
    this.#reasoningLineVisible = false;
    this.#reasoningBuffer = "";
    this.#markdown = new StreamingMarkdownRenderer();
    this.#usage = undefined;
    this.#finishedToolCalls.clear();
    this.#hadTools = false;
    this.#toolGroupPendingSeparator = false;
  }

  onReasoningDelta = (text: string): void => {
    if (!this.#showReasoning) {
      return;
    }

    this.#finalizeSpinner();
    this.#reasoningBuffer += text;
    this.#streamedReasoningForDecision = true;

    if (!this.#isInteractive()) {
      return;
    }

    const rawTail = formatReasoningTail(this.#reasoningBuffer, this.#reasoningTailMaxChars());
    if (rawTail === "") {
      return;
    }

    const marker = ansi.violet(REASONING_MARKER);
    const tail = ansi.dimPreservingStyles(renderInlineMarkdown(rawTail));
    process.stdout.write(`\r\x1b[2K${marker} ${tail}`);
    this.#reasoningLineVisible = true;
  };

  onTextDelta = (text: string): void => {
    this.#finalizeSpinner();
    this.closeReasoningBlock();

    if (!this.#streamedText) {
      if (this.#hadTools) {
        process.stdout.write("\n");
      }
      this.printAgentBlockStart();
      this.#streamedText = true;
    }

    if (this.#toolGroupPendingSeparator) {
      process.stdout.write("\n");
      this.#toolGroupPendingSeparator = false;
    }

    process.stdout.write(this.#markdown.push(text));
  };

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "model.requested":
        break;

      case "model.retry":
        console.log(
          ansi.yellow(
            `⚠ Повтор запроса к модели: ${event.reason}. Попытка ${event.nextAttempt}/${event.maxAttempts} начнётся через ${event.delayMs / 1_000} с.`,
          ),
        );
        break;

      case "model.usage":
        this.#usage = event.usage;
        break;

      case "decision":
        this.closeReasoningBlock();
        if (this.#showReasoning && !this.#streamedReasoningForDecision) {
          this.printReasoning(event.decision.reasoning);
        }
        this.#streamedReasoningForDecision = false;

        break;

      case "tool.started": {
        this.#eraseSpinner();
        this.#activeTools.set(event.call.id, {
          name: event.call.name,
          startedAt: Date.now(),
        });
        if (this.#streamedText && !this.#toolGroupPendingSeparator) {
          this.#writeLine("");
        }
        if (this.#streamedText) {
          this.#toolGroupPendingSeparator = true;
        }
        this.#hadTools = true;
        const label = formatToolLabel(event.call.name, event.call.input);
        const header = `${ansi.yellow("→")} ${ansi.bold(ansi.cyan(event.call.name))}`;
        this.#writeLine(label === "" ? header : `${header} ${ansi.dim(label)}`);
        this.#drawSpinner();
        this.#startSpinnerTimer();
        break;
      }

      case "tool.output":
        break;

      case "tool.finished": {
        this.#activeTools.delete(event.call.id);
        const result = formatToolResult(event.call, event.observation, event.durationMs);
        this.#eraseSpinner();
        const marker = result.failed ? ansi.red("✗") : ansi.green("✓");
        this.#writeLine(`${marker} ${result.text}`);
        if (this.#activeTools.size > 0) {
          this.#drawSpinner();
        } else {
          this.#stopSpinnerTimer();
          this.#spinnerFrame = 0;
        }
        this.#finishedToolCalls.add(event.call.id);
        break;
      }

      case "observation": {
        if (this.#finishedToolCalls.has(event.call.id)) break;
        this.#eraseSpinner();
        const marker = event.observation.ok ? ansi.green("✓") : ansi.red("✗");
        const detail = event.observation.ok
          ? event.call.name
          : singleLine(event.observation.error ?? "ошибка", ERROR_REASON_MAX_CHARS);
        this.#writeLine(`${marker} ${detail}`);
        break;
      }

      case "task":
      case "user":
        break;

      case "verification":
        console.log(
          ansi.yellow(
            `⚠ Самопроверка (${event.round}/${event.maxRounds}): ответ не прошёл гейт, ход продолжается на доработку.`,
          ),
        );
        break;
    }
  }

  printResult(result: AgentResult): void {
    this.#finalizeSpinner();
    switch (result.status) {
      case "completed":
        if (this.#streamedText) {
          process.stdout.write(this.#markdown.finish());
          this.printAgentBlockEnd();
        } else {
          const markdown = new StreamingMarkdownRenderer();
          this.printAgentBlockStart();
          process.stdout.write(markdown.push(result.answer));
          process.stdout.write(markdown.finish());
          this.printAgentBlockEnd();
        }
        this.printUsage();
        break;

      case "cancelled":
        console.error(ansi.red("Агент: работа отменена"));
        break;
    }
  }

  printChangeSummary(summary: TurnChangeSummary): void {
    this.#finalizeSpinner();
    const formatted = formatTurnChangeSummary(summary);
    if (!formatted) return;
    console.log(
      `\n${sectionHeader(
        "Изменения",
        (title) => ansi.bold(ansi.terracotta(title)),
        ansi.terracotta,
      )}`,
    );
    console.log(ansi.dim(formatted.replace(/^Изменения за ход\n?/u, "")));
    console.log(sectionFooter(ansi.terracotta));
  }

  #writeLine(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  #isInteractive(): boolean {
    return process.stdout.isTTY === true;
  }

  #eraseSpinner(): void {
    if (!this.#spinnerLineVisible) return;
    process.stdout.write("\r\x1b[2K");
    this.#spinnerLineVisible = false;
  }

  #drawSpinner(): void {
    if (!this.#isInteractive() || this.#activeTools.size === 0) return;
    const active = [...this.#activeTools.values()];
    const names = active.map((tool) => tool.name).join(", ");
    const oldest = active.reduce(
      (min, tool) => Math.min(min, tool.startedAt),
      Number.POSITIVE_INFINITY,
    );
    const line = `${SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length]} ${names} · ${formatDuration(
      Date.now() - oldest,
    )}`;
    this.#spinnerFrame += 1;
    process.stdout.write(`\r\x1b[2K${ansi.yellow(line)}`);
    this.#spinnerLineVisible = true;
  }

  #startSpinnerTimer(): void {
    if (!this.#isInteractive() || this.#spinnerTimer !== undefined) return;
    this.#spinnerTimer = setInterval(() => this.#drawSpinner(), SPINNER_INTERVAL_MS);
  }

  #stopSpinnerTimer(): void {
    if (this.#spinnerTimer === undefined) return;
    clearInterval(this.#spinnerTimer);
    this.#spinnerTimer = undefined;
  }

  #finalizeSpinner(): void {
    this.#stopSpinnerTimer();
    this.#eraseSpinner();
  }

  #reasoningTailMaxChars(): number {
    const width = process.stdout.columns ?? 80;
    return Math.max(12, width - 4);
  }

  private closeReasoningBlock(): void {
    const rawTail = formatReasoningTail(this.#reasoningBuffer, this.#reasoningTailMaxChars());
    this.#reasoningBuffer = "";

    if (rawTail !== "") {
      const tail = ansi.dimPreservingStyles(renderInlineMarkdown(rawTail));
      const line = `${ansi.green("✓")} ${tail}`;
      if (this.#reasoningLineVisible) {
        process.stdout.write(`\r\x1b[2K${line}\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
    }

    this.#reasoningLineVisible = false;
  }

  private printReasoning(reasoning: string | undefined): void {
    if (!reasoning || reasoning.trim() === "") {
      return;
    }

    const markdown = new StreamingMarkdownRenderer();
    const formatted = `${markdown.push(reasoning)}${markdown.finish()}`;

    console.log(sectionFooter());
    process.stdout.write(`${ansi.dimPreservingStyles(formatted)}\n`);
    console.log(sectionFooter());
  }

  private printUsage(): void {
    if (this.#usage) {
      console.log(ansi.dim(formatUsage(this.#usage)));
    }
  }

  private printAgentBlockStart(): void {
    process.stdout.write(
      `${sectionHeader("Ant", (title) => ansi.bold(ansi.green(title)), ansi.green)}\n`,
    );
  }

  private printAgentBlockEnd(): void {
    process.stdout.write(`\n${sectionFooter(ansi.green)}\n`);
  }
}

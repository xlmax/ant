import type { ReasoningDisplayMode } from "@ant/app";
import type {
  AgentEvent,
  AgentObserver,
  AgentResult,
  ModelUsage,
  Observation,
  ToolCall,
} from "@ant/core";
import { ansi } from "./ansi.js";
import { StreamingMarkdownRenderer } from "./markdown.js";
import { consoleWidth } from "./console-size.js";
import { sectionFooter, sectionHeader } from "./section.js";
import { TypingPump } from "./typing-pump.js";
import { formatTurnChangeSummary, type TurnChangeSummary } from "./turn-change-summary.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const TOOL_LABEL_MAX_CHARS = 60;
const ERROR_REASON_MAX_CHARS = 120;

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

export interface ConsoleRendererOptions {
  reasoningMode?: ReasoningDisplayMode;
  reasoningMaxLines?: number;
  /** Legacy test/adapter option: true maps to full, false to off. */
  showReasoning?: boolean;
  write?: (text: string) => void;
  interactive?: () => boolean;
}

export class ConsoleRenderer implements AgentObserver {
  #reasoningMode: ReasoningDisplayMode;
  readonly #reasoningMaxLines: number;
  #streamedText = false;
  #streamedReasoningForDecision = false;
  #reasoningMarkdown = new StreamingMarkdownRenderer();
  #reasoningOpen = false;
  #reasoningCompact = false;
  #markdown = new StreamingMarkdownRenderer();
  readonly #interactive: () => boolean;
  readonly #typing: TypingPump;
  #usage: ModelUsage | undefined;
  readonly #finishedToolCalls = new Set<string>();
  #activeTools = new Map<string, { name: string; startedAt: number }>();
  #spinnerTimer: ReturnType<typeof setInterval> | undefined;
  #spinnerFrame = 0;
  #spinnerLineVisible = false;
  #turnCancelled = false;
  #hadTools = false;
  #toolGroupPendingSeparator = false;

  constructor(options: ConsoleRendererOptions = {}) {
    this.#reasoningMode =
      options.reasoningMode ?? (options.showReasoning === true ? "full" : "off");
    this.#reasoningMaxLines = Math.min(20, Math.max(1, options.reasoningMaxLines ?? 6));
    this.#interactive = options.interactive ?? (() => process.stdout.isTTY === true);
    this.#typing = new TypingPump({
      write: options.write ?? ((text) => process.stdout.write(text)),
      interactive: this.#interactive,
    });
  }

  get reasoningMode(): ReasoningDisplayMode {
    return this.#reasoningMode;
  }

  get reasoningMaxLines(): number {
    return this.#reasoningMaxLines;
  }

  setReasoningMode(reasoningMode: ReasoningDisplayMode): void {
    this.#reasoningMode = reasoningMode;
  }

  beginTurn(): void {
    this.#finalizeSpinner();
    this.#activeTools.clear();
    this.#spinnerFrame = 0;
    this.#turnCancelled = false;
    this.#streamedText = false;
    this.#streamedReasoningForDecision = false;
    this.#reasoningMarkdown = this.#createReasoningMarkdown();
    this.#reasoningOpen = false;
    this.#reasoningCompact = false;
    this.#markdown = new StreamingMarkdownRenderer();
    this.#typing.cancel();
    this.#typing.resetRate();
    this.#usage = undefined;
    this.#finishedToolCalls.clear();
    this.#hadTools = false;
    this.#toolGroupPendingSeparator = false;
  }

  onReasoningDelta = (text: string): void => {
    if (this.#reasoningMode === "off") {
      return;
    }

    this.#finalizeSpinner();

    if (!this.#reasoningOpen) {
      if (text.trim() === "") {
        return;
      }
      this.#reasoningCompact = this.#reasoningMode === "compact" && this.#isInteractive();
      if (this.#reasoningCompact) {
        this.#typing.beginViewport({
          maxRows: this.#reasoningMaxLines,
          width: consoleWidth,
          frame: sectionFooter,
          styleRow: ansi.dim,
        });
      } else {
        this.#typing.holdCursor();
        this.#emitInstant(`${sectionFooter()}\n`);
      }
      this.#reasoningOpen = true;
    }

    this.#streamedReasoningForDecision = true;
    this.#typing.observeIncoming(text);
    const rendered = this.#reasoningMarkdown.push(text);
    if (this.#reasoningCompact) {
      this.#typing.pushViewport(rendered);
    } else {
      this.#emit(ansi.dimPreservingStyles(rendered));
    }
  };

  onTextDelta = (text: string): void => {
    this.#finalizeSpinner();
    this.closeReasoningBlock();
    this.#typing.observeIncoming(text);

    if (!this.#streamedText) {
      this.#typing.holdCursor();
      if (this.#hadTools) {
        this.#emitInstant("\n");
      }
      this.#emitInstant(
        `${sectionHeader("Ant", (title) => ansi.bold(ansi.green(title)), ansi.green)}\n`,
      );
      this.#streamedText = true;
    }

    if (this.#toolGroupPendingSeparator) {
      this.#emitInstant("\n");
      this.#toolGroupPendingSeparator = false;
    }

    this.#emit(this.#markdown.push(text));
  };

  async onEvent(event: AgentEvent): Promise<void> {
    if (
      this.#turnCancelled &&
      (event.type === "tool.started" ||
        event.type === "tool.output" ||
        event.type === "tool.finished" ||
        event.type === "observation")
    ) {
      return;
    }

    switch (event.type) {
      case "model.requested":
        break;

      case "model.retry":
        this.#emitInstant(
          `${ansi.yellow(
            `⚠ Повтор запроса к модели: ${event.reason}. Попытка ${event.nextAttempt}/${event.maxAttempts} начнётся через ${event.delayMs / 1_000} с.`,
          )}\n`,
        );
        break;

      case "model.usage":
        this.#usage = event.usage;
        break;

      case "decision":
        this.closeReasoningBlock();
        if (this.#reasoningMode !== "off" && !this.#streamedReasoningForDecision) {
          this.printReasoning(event.decision.reasoning);
        }
        this.#streamedReasoningForDecision = false;

        break;

      case "tool.started": {
        const startedAt = Date.now();
        await this.#typing.enterLiveMode();
        if (this.#turnCancelled) {
          this.#typing.leaveLiveMode();
          break;
        }
        this.#eraseSpinner();
        this.#activeTools.set(event.call.id, {
          name: event.call.name,
          startedAt,
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
          this.#typing.leaveLiveMode();
          this.#spinnerFrame = 0;
        }
        this.#finishedToolCalls.add(event.call.id);
        break;
      }

      case "observation": {
        if (this.#finishedToolCalls.has(event.call.id)) break;
        await this.#typing.enterLiveMode();
        if (this.#turnCancelled) {
          this.#typing.leaveLiveMode();
          break;
        }
        this.#eraseSpinner();
        const marker = event.observation.ok ? ansi.green("✓") : ansi.red("✗");
        const detail = event.observation.ok
          ? event.call.name
          : singleLine(event.observation.error ?? "ошибка", ERROR_REASON_MAX_CHARS);
        this.#writeLine(`${marker} ${detail}`);
        this.#typing.leaveLiveMode();
        break;
      }

      case "task":
      case "user":
        break;

      case "verification":
        this.#emitInstant(
          `${ansi.yellow(
            `⚠ Самопроверка (${event.round}/${event.maxRounds}): ответ не прошёл гейт, ход продолжается на доработку.`,
          )}\n`,
        );
        break;
    }
  }

  async printResult(result: AgentResult): Promise<void> {
    this.#finalizeSpinner();
    switch (result.status) {
      case "completed":
        if (this.#streamedText) {
          this.#emit(this.#markdown.finish());
          this.printAgentBlockEnd();
        } else {
          const markdown = new StreamingMarkdownRenderer();
          this.#typing.holdCursor();
          this.#typing.observeIncoming(result.answer);
          this.printAgentBlockStart();
          this.#emit(markdown.push(result.answer));
          this.#emit(markdown.finish());
          this.printAgentBlockEnd();
        }
        this.printUsage();
        this.#typing.releaseCursor();
        await this.#typing.whenIdle();
        break;

      case "cancelled":
        this.#turnCancelled = true;
        this.#typing.cancel();
        console.error(ansi.red("Агент: работа отменена"));
        break;
    }
  }

  async printChangeSummary(summary: TurnChangeSummary): Promise<void> {
    this.#finalizeSpinner();
    const formatted = formatTurnChangeSummary(summary);
    if (!formatted) return;
    this.#emitInstant(
      `\n${sectionHeader(
        "Изменения",
        (title) => ansi.bold(ansi.terracotta(title)),
        ansi.terracotta,
      )}\n${ansi.dim(formatted.replace(/^Изменения за ход\n?/u, ""))}\n${sectionFooter(
        ansi.terracotta,
      )}\n`,
    );
    await this.#typing.whenIdle();
  }

  printCancellationPending(): void {
    this.#turnCancelled = true;
    this.#finalizeSpinner();
    this.#typing.cancel();
    this.#emitInstant(`${ansi.yellow("Отмена текущего хода…")}\n`);
  }

  dispose(): void {
    this.#finalizeSpinner();
    this.#typing.cancel();
  }

  #writeLine(text: string): void {
    this.#typing.writeLiveLine(text);
  }

  #isInteractive(): boolean {
    return this.#interactive();
  }

  #emit(text: string): void {
    this.#typing.push(text);
  }

  #emitInstant(text: string): void {
    this.#typing.pushInstant(text);
  }

  #eraseSpinner(): void {
    if (!this.#spinnerLineVisible) return;
    this.#typing.clearLiveLine();
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
    this.#typing.updateLiveLine(ansi.yellow(line));
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

  private closeReasoningBlock(): void {
    if (!this.#reasoningOpen) {
      return;
    }

    const tail = this.#reasoningMarkdown.finish();
    if (this.#reasoningCompact) {
      this.#typing.pushViewport(tail);
      this.#typing.closeViewport();
    } else {
      this.#emit(ansi.dimPreservingStyles(tail));
      this.#emitInstant(`\n${sectionFooter()}\n`);
      this.#typing.releaseCursor();
    }

    this.#reasoningOpen = false;
    this.#reasoningCompact = false;
  }

  private printReasoning(reasoning: string | undefined): void {
    if (!reasoning || reasoning.trim() === "") {
      return;
    }

    this.#typing.observeIncoming(reasoning);
    const compact = this.#reasoningMode === "compact" && this.#isInteractive();
    const markdown = this.#createReasoningMarkdown();
    const rendered = `${markdown.push(reasoning)}${markdown.finish()}`;
    if (compact) {
      this.#typing.beginViewport({
        maxRows: this.#reasoningMaxLines,
        width: consoleWidth,
        frame: sectionFooter,
        styleRow: ansi.dim,
      });
      this.#typing.pushViewport(rendered);
      this.#typing.closeViewport();
    } else {
      this.#typing.holdCursor();
      this.#emitInstant(`${sectionFooter()}\n`);
      this.#emit(ansi.dimPreservingStyles(rendered));
      this.#emitInstant(`\n${sectionFooter()}\n`);
      this.#typing.releaseCursor();
    }
  }

  #createReasoningMarkdown(): StreamingMarkdownRenderer {
    return this.#reasoningMode === "compact" && this.#isInteractive()
      ? new StreamingMarkdownRenderer({ maxTableWidth: consoleWidth })
      : new StreamingMarkdownRenderer();
  }

  private printUsage(): void {
    if (this.#usage) {
      this.#emitInstant(`${ansi.dim(formatUsage(this.#usage))}\n`);
    }
  }

  private printAgentBlockStart(): void {
    this.#emitInstant(
      `${sectionHeader("Ant", (title) => ansi.bold(ansi.green(title)), ansi.green)}\n`,
    );
  }

  private printAgentBlockEnd(): void {
    this.#emitInstant(`\n${sectionFooter(ansi.green)}\n`);
  }
}

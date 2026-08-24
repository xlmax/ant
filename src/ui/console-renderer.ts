import type { AgentEvent, AgentObserver, AgentResult, ModelUsage } from "../core/agent.js";
import { ansi } from "./ansi.js";
import { StreamingMarkdownRenderer } from "./markdown.js";
import { sectionFooter, sectionHeader } from "./section.js";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatStreamedResult(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.exitCode !== "number" && record.exitCode !== null) return undefined;
  const status = record.exitCode === 0 ? "exit 0" : `exit ${String(record.exitCode)}`;
  return record.truncated === true ? `${status} · сохранённый вывод обрезан` : status;
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
  #reasoningBlockOpen = false;
  #reasoningMarkdown = new StreamingMarkdownRenderer();
  #markdown = new StreamingMarkdownRenderer();
  #usage: ModelUsage | undefined;
  readonly #streamedToolCalls = new Set<string>();
  readonly #finishedToolCalls = new Set<string>();
  readonly #toolOutputEndsWithNewline = new Map<string, boolean>();

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
    this.#streamedText = false;
    this.#streamedReasoningForDecision = false;
    this.#reasoningBlockOpen = false;
    this.#reasoningMarkdown = new StreamingMarkdownRenderer();
    this.#markdown = new StreamingMarkdownRenderer();
    this.#usage = undefined;
    this.#streamedToolCalls.clear();
    this.#finishedToolCalls.clear();
    this.#toolOutputEndsWithNewline.clear();
  }

  onReasoningDelta = (text: string): void => {
    if (!this.#showReasoning) {
      return;
    }

    if (!this.#reasoningBlockOpen) {
      process.stdout.write(`${sectionHeader("Рассуждения", (title) => ansi.dim(title))}\n`);
      this.#reasoningBlockOpen = true;
    }

    this.#streamedReasoningForDecision = true;
    process.stdout.write(ansi.dimPreservingStyles(this.#reasoningMarkdown.push(text)));
  };

  onTextDelta = (text: string): void => {
    this.closeReasoningBlock();

    if (!this.#streamedText) {
      this.printAgentBlockStart();
      this.#streamedText = true;
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

      case "tool.started":
        console.log(
          `${ansi.yellow("→")} ${ansi.bold(ansi.cyan(event.call.name))} ${ansi.dim(`(${event.call.id})`)} ${ansi.dim(formatValue(event.call.input))}`,
        );
        break;

      case "tool.output":
        if (!this.#streamedToolCalls.has(event.call.id)) {
          this.#streamedToolCalls.add(event.call.id);
          console.log(ansi.dim(`  ${event.output.stream}:`));
        }
        process.stdout.write(
          event.output.stream === "stderr"
            ? ansi.yellow(event.output.content)
            : event.output.content,
        );
        this.#toolOutputEndsWithNewline.set(
          event.call.id,
          event.output.content.endsWith("\n") || event.output.content.endsWith("\r"),
        );
        break;

      case "tool.finished": {
        const streamed = this.#streamedToolCalls.has(event.call.id);
        if (streamed && this.#toolOutputEndsWithNewline.get(event.call.id) === false) {
          process.stdout.write("\n");
        }
        const result = event.observation.ok
          ? streamed
            ? (formatStreamedResult(event.observation.value) ?? "готово")
            : formatValue(event.observation.value)
          : `${ansi.red("Ошибка:")} ${event.observation.error}`;
        console.log(
          `${event.observation.ok ? ansi.green("←") : ansi.red("←")} ${result} ${ansi.dim(`· ${formatDuration(event.durationMs)}`)}`,
        );
        this.#finishedToolCalls.add(event.call.id);
        break;
      }

      case "observation":
        if (this.#finishedToolCalls.has(event.call.id)) break;
        console.log(
          event.observation.ok
            ? `${ansi.green("←")} ${ansi.dim(formatValue(event.observation.value))}`
            : `${ansi.red("← Ошибка:")} ${event.observation.error}`,
        );
        break;

      case "task":
      case "user":
        break;
    }
  }

  printResult(result: AgentResult): void {
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

  private closeReasoningBlock(): void {
    if (this.#reasoningBlockOpen) {
      process.stdout.write(ansi.dimPreservingStyles(this.#reasoningMarkdown.finish()));
      process.stdout.write(`\n${sectionFooter()}\n`);
      this.#reasoningBlockOpen = false;
    }
  }

  private printReasoning(reasoning: string | undefined): void {
    if (!reasoning) {
      return;
    }

    const markdown = new StreamingMarkdownRenderer();
    const formatted = `${markdown.push(reasoning)}${markdown.finish()}`;

    console.log(sectionHeader("Рассуждения", (title) => ansi.dim(title)));
    process.stdout.write(`${ansi.dimPreservingStyles(formatted)}\n`);
    console.log(sectionFooter());
  }

  private printUsage(): void {
    if (this.#usage) {
      console.log(ansi.dim(formatUsage(this.#usage)));
    }
  }

  private printAgentBlockStart(): void {
    process.stdout.write(`${sectionHeader("Агент", (text) => ansi.bold(ansi.green(text)))}\n`);
  }

  private printAgentBlockEnd(): void {
    process.stdout.write(`\n${sectionFooter()}\n`);
  }
}

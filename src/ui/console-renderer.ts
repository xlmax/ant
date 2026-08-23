import type {
  AgentEvent,
  AgentObserver,
  AgentResult,
  ModelUsage,
} from "../core/agent.js";
import { ansi } from "./ansi.js";
import { StreamingMarkdownRenderer } from "./markdown.js";
import { sectionFooter, sectionHeader } from "./section.js";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
  const filled = Math.min(
    segments,
    Math.max(percentage > 0 ? 1 : 0, Math.round(percentage / 10)),
  );
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
  #markdown = new StreamingMarkdownRenderer();
  #usage: ModelUsage | undefined;

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
    this.#markdown = new StreamingMarkdownRenderer();
    this.#usage = undefined;
  }

  onReasoningDelta = (text: string): void => {
    if (!this.#showReasoning) {
      return;
    }

    if (!this.#reasoningBlockOpen) {
      process.stdout.write(
        `${sectionHeader("Рассуждения", (title) => ansi.dim(title))}\n`,
      );
      this.#reasoningBlockOpen = true;
    }

    this.#streamedReasoningForDecision = true;
    process.stdout.write(ansi.dim(text));
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
      case "model.usage":
        this.#usage = event.usage;
        break;

      case "decision":
        this.closeReasoningBlock();
        if (this.#showReasoning && !this.#streamedReasoningForDecision) {
          this.printReasoning(event.decision.reasoning);
        }
        this.#streamedReasoningForDecision = false;

        if (event.decision.type === "tools") {
          for (const call of event.decision.calls) {
            console.log(
              `${ansi.yellow("→")} ${ansi.bold(ansi.cyan(call.name))} ${ansi.dim(`(${call.id})`)} ${ansi.dim(formatValue(call.input))}`,
            );
          }
        }
        break;

      case "observation":
        console.log(
          event.observation.ok
            ? `${ansi.green("←")} ${ansi.dim(formatValue(event.observation.value))}`
            : `${ansi.red("← Ошибка:")} ${event.observation.error}`,
        );
        break;

      case "task":
      case "user":
      case "model.requested":
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

      case "waiting":
        console.log(sectionHeader("Агент?", (text) => ansi.bold(ansi.yellow(text))));
        console.log(result.question);
        console.log(sectionFooter());
        this.printUsage();
        break;

      case "cancelled":
        console.error(ansi.red("Агент: работа отменена"));
        break;
    }
  }

  private closeReasoningBlock(): void {
    if (this.#reasoningBlockOpen) {
      process.stdout.write(`\n${sectionFooter()}\n`);
      this.#reasoningBlockOpen = false;
    }
  }

  private printReasoning(reasoning: string | undefined): void {
    if (!reasoning) {
      return;
    }

    console.log(sectionHeader("Рассуждения", (title) => ansi.dim(title)));
    console.log(ansi.dim(reasoning));
    console.log(sectionFooter());
  }

  private printUsage(): void {
    if (this.#usage) {
      console.log(ansi.dim(formatUsage(this.#usage)));
    }
  }

  private printAgentBlockStart(): void {
    process.stdout.write(
      `${sectionHeader("Агент", (text) => ansi.bold(ansi.green(text)))}\n`,
    );
  }

  private printAgentBlockEnd(): void {
    process.stdout.write(`\n${sectionFooter()}\n`);
  }
}

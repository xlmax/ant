import type {
  AgentEvent,
  AgentObserver,
  AgentResult,
} from "../core/agent.js";
import { ansi } from "./ansi.js";
import { StreamingMarkdownRenderer } from "./markdown.js";
import { sectionFooter, sectionHeader } from "./section.js";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class ConsoleRenderer implements AgentObserver {
  #streamedText = false;
  #markdown = new StreamingMarkdownRenderer();

  beginTurn(): void {
    this.#streamedText = false;
    this.#markdown = new StreamingMarkdownRenderer();
  }

  onTextDelta = (text: string): void => {
    if (!this.#streamedText) {
      this.printAgentBlockStart();
      this.#streamedText = true;
    }

    process.stdout.write(this.#markdown.push(text));
  };

  async onEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "decision":
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
        break;

      case "waiting":
        console.log(sectionHeader("Агент?", (text) => ansi.bold(ansi.yellow(text))));
        console.log(result.question);
        console.log(sectionFooter());
        break;

      case "cancelled":
        console.error(ansi.red("Агент: работа отменена"));
        break;
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

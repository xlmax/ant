import { ansi } from "./ansi.js";
import { highlightCode } from "./syntax-highlight.js";

function renderInline(text: string): string {
  return text.replace(
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/gu,
    (token) => {
      if (token.startsWith("`")) {
        return ansi.yellow(token.slice(1, -1));
      }

      if (token.startsWith("**")) {
        return ansi.bold(token.slice(2, -2));
      }

      return ansi.dim(token.slice(1, -1));
    },
  );
}

export class StreamingMarkdownRenderer {
  #buffer = "";
  #inCodeBlock = false;
  #codeLanguage: string | undefined;

  push(text: string): string {
    this.#buffer += text;
    let output = "";
    let newline = this.#buffer.indexOf("\n");

    while (newline !== -1) {
      output += `${this.renderLine(this.#buffer.slice(0, newline))}\n`;
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }

    return output;
  }

  finish(): string {
    if (this.#buffer === "") {
      return "";
    }

    const output = this.renderLine(this.#buffer);
    this.#buffer = "";
    return output;
  }

  private renderLine(line: string): string {
    const fence = line.match(/^```(.*)$/u);

    if (fence) {
      this.#inCodeBlock = !this.#inCodeBlock;
      const language = fence[1]?.trim();

      if (this.#inCodeBlock) {
        this.#codeLanguage = language;
        return ansi.dim(`┌─ code${language ? `: ${language}` : ""}`);
      }

      this.#codeLanguage = undefined;
      return ansi.dim("└─");
    }

    if (this.#inCodeBlock) {
      return `  ${highlightCode(line, this.#codeLanguage)}`;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/u);

    if (heading) {
      const [, markers, content] = heading;
      const level = markers?.length ?? 1;
      const rendered = renderInline(content ?? "");
      return level <= 2
        ? ansi.bold(ansi.cyan(rendered))
        : ansi.bold(rendered);
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/u);

    if (bullet) {
      return `${ansi.cyan("•")} ${renderInline(bullet[1] ?? "")}`;
    }

    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/u);

    if (numbered) {
      return `${ansi.cyan(`${numbered[1]}.`)} ${renderInline(numbered[2] ?? "")}`;
    }

    const quote = line.match(/^>\s?(.*)$/u);

    if (quote) {
      return `${ansi.dim("│")} ${ansi.dim(renderInline(quote[1] ?? ""))}`;
    }

    return renderInline(line);
  }
}

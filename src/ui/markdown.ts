import { Lexer, type Token } from "marked";

import { ansi } from "./ansi.js";
import { highlightCode } from "./syntax-highlight.js";

type TableAlignment = "left" | "center" | "right";

interface MarkdownTable {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

function renderInlineTokens(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "escape":
          return token.text;

        case "codespan":
          return ansi.yellow(token.text);

        case "strong":
          return ansi.bold(renderInlineTokens(token.tokens ?? []));

        case "em":
          return ansi.dim(renderInlineTokens(token.tokens ?? []));

        case "del":
          return ansi.dim(renderInlineTokens(token.tokens ?? []));

        case "link":
        case "image":
          return renderInlineTokens(token.tokens ?? []);

        case "br":
          return "\n";

        default:
          return "tokens" in token && Array.isArray(token.tokens)
            ? renderInlineTokens(token.tokens)
            : token.raw;
      }
    })
    .join("");
}

function renderInline(text: string): string {
  return renderInlineTokens(Lexer.lexInline(text));
}

function parseTableRow(line: string): string[] | undefined {
  if (!line.includes("|")) {
    return undefined;
  }

  const trimmed = line.trim().replace(/^\||\|$/gu, "");
  const cells = trimmed.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : undefined;
}

function parseTableSeparator(line: string): TableAlignment[] | undefined {
  const cells = parseTableRow(line);

  if (!cells || !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
    return undefined;
  }

  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");

    if (left && right) {
      return "center";
    }

    return right ? "right" : "left";
  });
}

function visibleWidth(text: string): number {
  return Array.from(text.replaceAll("`", "").replaceAll("**", "").replaceAll("*", "")).length;
}

function padCell(cell: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - visibleWidth(cell));

  if (alignment === "right") {
    return `${" ".repeat(padding)}${cell}`;
  }

  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${cell}${" ".repeat(padding - left)}`;
  }

  return `${cell}${" ".repeat(padding)}`;
}

export class StreamingMarkdownRenderer {
  #buffer = "";
  #inCodeBlock = false;
  #codeLanguage: string | undefined;
  #pendingTableHeader: string | undefined;
  #table: MarkdownTable | undefined;

  push(text: string): string {
    this.#buffer += text;
    let output = "";
    let newline = this.#buffer.indexOf("\n");

    while (newline !== -1) {
      const rendered = this.processLine(this.#buffer.slice(0, newline));
      if (rendered !== undefined) {
        output += `${rendered}\n`;
      }
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
    }

    return output;
  }

  finish(): string {
    const output: string[] = [];

    if (this.#buffer !== "") {
      const rendered = this.processLine(this.#buffer);
      if (rendered !== undefined) {
        output.push(rendered);
      }
      this.#buffer = "";
    }

    const table = this.flushTable();
    if (table !== undefined) {
      output.push(table);
    }

    return output.join("\n");
  }

  private processLine(line: string): string | undefined {
    if (this.#table) {
      const row = parseTableRow(line);

      if (row && row.length === this.#table.header.length) {
        this.#table.rows.push(row);
        return undefined;
      }

      const table = this.flushTable();
      const rendered = this.processLine(line);
      return rendered === undefined ? table : `${table}\n${rendered}`;
    }

    if (this.#pendingTableHeader !== undefined) {
      const header = parseTableRow(this.#pendingTableHeader);
      const alignments = parseTableSeparator(line);

      if (header && alignments && header.length === alignments.length) {
        this.#table = { header, alignments, rows: [] };
        this.#pendingTableHeader = undefined;
        return undefined;
      }

      const pending = this.#pendingTableHeader;
      this.#pendingTableHeader = undefined;
      const rendered = this.processLine(line);
      const previous = this.renderLine(pending);
      return rendered === undefined ? previous : `${previous}\n${rendered}`;
    }

    if (!this.#inCodeBlock && parseTableRow(line)) {
      this.#pendingTableHeader = line;
      return undefined;
    }

    return this.renderLine(line);
  }

  private flushTable(): string | undefined {
    if (this.#table) {
      const table = this.renderTable(this.#table);
      this.#table = undefined;
      return table;
    }

    if (this.#pendingTableHeader !== undefined) {
      const header = this.renderLine(this.#pendingTableHeader);
      this.#pendingTableHeader = undefined;
      return header;
    }

    return undefined;
  }

  private renderTable(table: MarkdownTable): string {
    const widths = table.header.map((header, index) =>
      Math.max(visibleWidth(header), ...table.rows.map((row) => visibleWidth(row[index] ?? ""))),
    );
    const renderRow = (row: readonly string[], header = false): string => {
      const cells = row.map((cell, index) => {
        const padded = padCell(
          cell,
          widths[index] ?? visibleWidth(cell),
          table.alignments[index] ?? "left",
        );
        const rendered = renderInline(padded);
        return header ? ansi.bold(rendered) : rendered;
      });

      return `  ${cells.join("  ")}`;
    };
    const separator = `  ${widths.map((width) => "─".repeat(width)).join("  ")}`;

    return [
      renderRow(table.header, true),
      ansi.dim(separator),
      ...table.rows.map((row) => renderRow(row)),
    ].join("\n");
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
      return level <= 2 ? ansi.bold(ansi.cyan(rendered)) : ansi.bold(rendered);
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

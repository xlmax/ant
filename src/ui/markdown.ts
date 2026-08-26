import { Lexer, type Token } from "marked";

import { ansi } from "./ansi.js";
import { displayWidth } from "./display-width.js";
import { highlightCode } from "./syntax-highlight.js";

type TableAlignment = "left" | "center" | "right";

export interface StreamingMarkdownRendererOptions {
  maxTableWidth?: () => number;
}

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
  return displayWidth(text.replaceAll("`", "").replaceAll("**", "").replaceAll("*", ""));
}

function padRenderedCell(cell: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - displayWidth(cell));

  if (alignment === "right") {
    return `${" ".repeat(padding)}${cell}`;
  }

  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${cell}${" ".repeat(padding - left)}`;
  }

  return `${cell}${" ".repeat(padding)}`;
}

const ANSI_TOKEN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "yu");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateRendered(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const target = Math.max(0, width - 1);
  let output = "";
  let used = 0;
  let offset = 0;
  let sawAnsi = false;

  while (offset < text.length) {
    ANSI_TOKEN.lastIndex = offset;
    const ansiToken = ANSI_TOKEN.exec(text)?.[0];
    if (ansiToken !== undefined) {
      output += ansiToken;
      sawAnsi = true;
      offset += ansiToken.length;
      continue;
    }

    const nextEscape = text.indexOf("\x1b", offset);
    const plainEnd = nextEscape === -1 ? text.length : nextEscape;
    const plain = text.slice(offset, plainEnd);
    for (const segment of graphemeSegmenter.segment(plain)) {
      const segmentWidth = displayWidth(segment.segment);
      if (used + segmentWidth > target) return `${output}…${sawAnsi ? "\x1b[0m" : ""}`;
      output += segment.segment;
      used += segmentWidth;
    }
    offset = plainEnd;
    if (nextEscape === offset && offset < text.length) {
      output += text[offset];
      offset += 1;
    }
  }

  return `${output}…${sawAnsi ? "\x1b[0m" : ""}`;
}

function fitColumnWidths(
  widths: readonly number[],
  maxTableWidth: number,
  indentWidth: number,
): number[] {
  const gaps = Math.max(0, widths.length - 1) * 2;
  const available = Math.max(widths.length, maxTableWidth - indentWidth - gaps);
  const fitted = widths.map((width) => Math.max(1, width));

  while (fitted.reduce((sum, width) => sum + width, 0) > available) {
    let widestIndex = -1;
    for (const [index, width] of fitted.entries()) {
      if (width > 1 && (widestIndex === -1 || width > (fitted[widestIndex] ?? 0))) {
        widestIndex = index;
      }
    }
    if (widestIndex === -1) break;
    fitted[widestIndex] = (fitted[widestIndex] ?? 1) - 1;
  }

  return fitted;
}

function limitTableColumns(
  table: MarkdownTable,
  maxTableWidth: number,
  indentWidth: number,
): MarkdownTable {
  const maxColumns = Math.max(1, Math.floor((maxTableWidth - indentWidth + 2) / 3));
  if (table.header.length <= maxColumns) return table;
  if (maxColumns === 1) {
    return {
      header: ["…"],
      alignments: ["left"],
      rows: table.rows.map(() => ["…"]),
    };
  }

  const retained = maxColumns - 1;
  return {
    header: [...table.header.slice(0, retained), "…"],
    alignments: [...table.alignments.slice(0, retained), "left"],
    rows: table.rows.map((row) => [...row.slice(0, retained), "…"]),
  };
}

export class StreamingMarkdownRenderer {
  readonly #options: StreamingMarkdownRendererOptions;
  #buffer = "";
  #inCodeBlock = false;
  #codeLanguage: string | undefined;
  #pendingTableHeader: string | undefined;
  #table: MarkdownTable | undefined;

  constructor(options: StreamingMarkdownRendererOptions = {}) {
    this.#options = options;
  }

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
    const configuredWidth = this.#options.maxTableWidth?.();
    const maxTableWidth = configuredWidth === undefined ? undefined : Math.max(1, configuredWidth);
    const indentWidth = maxTableWidth === undefined ? 2 : Math.min(2, maxTableWidth - 1);
    const displayedTable =
      maxTableWidth === undefined ? table : limitTableColumns(table, maxTableWidth, indentWidth);
    const naturalWidths = displayedTable.header.map((header, index) =>
      Math.max(
        visibleWidth(header),
        ...displayedTable.rows.map((row) => visibleWidth(row[index] ?? "")),
      ),
    );
    const widths =
      maxTableWidth === undefined
        ? naturalWidths
        : fitColumnWidths(naturalWidths, maxTableWidth, indentWidth);
    const prefix = " ".repeat(indentWidth);
    const renderRow = (row: readonly string[], header = false): string => {
      const cells = row.map((cell, index) => {
        const width = widths[index] ?? visibleWidth(cell);
        const rendered = truncateRendered(renderInline(cell), width);
        const padded = padRenderedCell(rendered, width, displayedTable.alignments[index] ?? "left");
        return header ? ansi.bold(padded) : padded;
      });

      return `${prefix}${cells.join("  ")}`;
    };
    const separator = `${prefix}${widths.map((width) => "─".repeat(width)).join("  ")}`;

    return [
      renderRow(displayedTable.header, true),
      ansi.dim(separator),
      ...displayedTable.rows.map((row) => renderRow(row)),
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

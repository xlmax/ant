export interface ReasoningViewportOptions {
  maxRows: number;
  width: () => number;
  frame: () => string;
  styleRow: (text: string) => string;
}

export interface ViewportUnit {
  text: string;
  width: number;
  lineBreak: boolean;
}

/**
 * Maintains a bounded set of terminal rows and renders it as a live region.
 * The cursor rests on the footer between redraws; as rows are added, the old
 * footer is replaced and moved down. Once full, every new row scrolls the
 * viewport while the surrounding terminal transcript remains untouched.
 */
export class ReasoningViewport {
  readonly #options: ReasoningViewportOptions;
  #rows: string[] = [];
  #current = "";
  #currentWidth = 0;
  #hasCurrent = false;
  #started = false;
  #displayedRows = 0;
  #dirty = true;

  constructor(options: ReasoningViewportOptions) {
    this.#options = options;
  }

  append(unit: ViewportUnit): void {
    const width = Math.max(1, this.#options.width());
    if (unit.lineBreak) {
      this.#commitRow(this.#current);
      this.#current = "";
      this.#currentWidth = 0;
      this.#hasCurrent = false;
      this.#dirty = true;
      return;
    }

    if (this.#hasCurrent && unit.width > 0 && this.#currentWidth + unit.width > width) {
      this.#commitRow(this.#current);
      this.#current = "";
      this.#currentWidth = 0;
      this.#hasCurrent = false;
    }

    this.#current += unit.text;
    this.#currentWidth += unit.width;
    this.#hasCurrent = true;
    this.#dirty = true;
  }

  redraw(): string {
    if (!this.#dirty && this.#started) return "";
    const rows = this.#visibleRows();
    const frame = this.#options.frame();
    const renderedRows = rows.map((row) => this.#options.styleRow(row));
    let output: string;

    if (!this.#started) {
      output = `${frame}\n${renderedRows.map((row) => `${row}\n`).join("")}${frame}`;
      this.#started = true;
    } else {
      output = "\r";
      if (this.#displayedRows > 0) output += `\x1b[${this.#displayedRows}A`;
      for (const row of renderedRows) {
        output += `\r\x1b[2K${row}\n`;
      }
      output += `\r\x1b[2K${frame}`;
    }

    this.#displayedRows = rows.length;
    this.#dirty = false;
    return output;
  }

  finish(): string {
    return `${this.redraw()}\n`;
  }

  cancel(): string {
    return this.#started ? "\n" : "";
  }

  visibleRows(): readonly string[] {
    return this.#visibleRows();
  }

  #commitRow(row: string): void {
    this.#rows.push(row);
    if (this.#rows.length > this.#options.maxRows) this.#rows.shift();
  }

  #visibleRows(): string[] {
    const all = [...this.#rows, ...(this.#hasCurrent ? [this.#current] : [])];
    return all.slice(-this.#options.maxRows);
  }
}

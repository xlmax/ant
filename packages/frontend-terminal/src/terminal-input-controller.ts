import type { TerminalInputEvent } from "./console-input-action.js";
import { displayWidth } from "./display-width.js";
import { InputHistory } from "./input-history.js";
import { TextEditor, type CursorPosition } from "./text-editor.js";

export interface TerminalOutputStream {
  readonly columns?: number;
  write(value: string): unknown;
}

export type TerminalInputResult = { done: false } | { done: true; value: string | undefined };

export function canEraseInline(before: CursorPosition, after: CursorPosition): boolean {
  return before.row === after.row;
}

export function resolveCancelInput(value: string): "clear" | "exit" {
  return value === "" ? "exit" : "clear";
}

function moveCursor(from: CursorPosition, to: CursorPosition, output: TerminalOutputStream): void {
  const rows = to.row - from.row;

  if (rows === 0) {
    const columns = to.column - from.column;
    if (columns < 0) output.write(`\u001B[${-columns}D`);
    else if (columns > 0) output.write(`\u001B[${columns}C`);
    return;
  }

  output.write(rows < 0 ? `\u001B[${-rows}A` : `\u001B[${rows}B`);
  output.write("\r");
  if (to.column > 0) output.write(`\u001B[${to.column + 1}G`);
}

function redraw(
  editor: TextEditor,
  previousCursor: CursorPosition,
  prompt: string,
  output: TerminalOutputStream,
): CursorPosition {
  output.write("\u001B[?25l");
  if (previousCursor.row > 0) output.write(`\u001B[${previousCursor.row}A`);
  output.write("\r\u001B[J");

  const columns = Math.max(1, output.columns ?? 80);
  const rendered = editor.render(columns, prompt);
  output.write(rendered.text);

  const rowsUp = rendered.end.row - rendered.cursor.row;
  if (rowsUp > 0) output.write(`\u001B[${rowsUp}A`);
  output.write("\r");
  if (rendered.cursor.column > 0) {
    output.write(`\u001B[${Math.min(columns, rendered.cursor.column + 1)}G`);
  }
  output.write("\u001B[?25h");
  return rendered.cursor;
}

export class TerminalInputController {
  readonly #history: InputHistory;
  readonly #prompt: string;
  readonly #output: TerminalOutputStream;
  readonly #editor = new TextEditor();
  #cursor: CursorPosition;

  constructor(history: InputHistory, prompt: string, output: TerminalOutputStream) {
    this.#history = history;
    this.#prompt = prompt;
    this.#output = output;
    output.write(prompt);
    this.#cursor = this.#editor.render(Math.max(1, output.columns ?? 80), prompt).cursor;
  }

  get value(): string {
    return this.#editor.value;
  }

  handle(event: TerminalInputEvent): TerminalInputResult {
    if (event.type === "paste") {
      this.#history.reset();
      this.#editor.insert(event.value);
      this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
      return { done: false };
    }

    const { action } = event;
    if (action.type === "up" && (this.#editor.value === "" || this.#history.isBrowsing)) {
      const previous = this.#history.previous(this.#editor.value);
      if (previous !== undefined) {
        this.#editor.replace(previous);
        this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
      }
      return { done: false };
    }

    if (action.type === "down" && this.#history.isBrowsing) {
      const next = this.#history.next();
      if (next !== undefined) {
        this.#editor.replace(next);
        this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
      }
      return { done: false };
    }

    if (action.type === "submit") {
      if (this.#editor.value.trim() === "") {
        if (this.#editor.value !== "") {
          this.#editor.replace("");
          this.#history.reset();
          this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
        }
        return { done: false };
      }
      this.#output.write("\n");
      return { done: true, value: this.#editor.value };
    }

    if (action.type === "cancel") {
      if (resolveCancelInput(this.#editor.value) === "exit") {
        this.#output.write("\n");
        return { done: true, value: undefined };
      }
      this.#editor.replace("");
      this.#history.reset();
      this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
      return { done: false };
    }

    if (action.type === "eof") {
      if (this.#editor.value === "") {
        this.#output.write("\n");
        return { done: true, value: undefined };
      }
      return { done: false };
    }

    if (action.type === "ignore") return { done: false };

    if (
      action.type === "character" ||
      action.type === "newline" ||
      action.type === "backspace" ||
      action.type === "delete"
    ) {
      this.#history.reset();
    }

    const columns = Math.max(1, this.#output.columns ?? 80);
    const promptWidth = displayWidth(this.#prompt);
    const cursorAtEnd = this.#editor.cursorAtEnd;
    const renderedBefore = this.#editor.render(columns, this.#prompt);
    const appendAtEnd = cursorAtEnd && (action.type === "character" || action.type === "newline");
    const inlineEraseCandidate =
      cursorAtEnd &&
      action.type === "backspace" &&
      this.#editor.characterBeforeCursor !== undefined &&
      this.#editor.characterBeforeCursor !== "\n" &&
      renderedBefore.cursor.column > 0;
    const moveCursorOnly =
      action.type === "left" ||
      action.type === "right" ||
      action.type === "up" ||
      action.type === "down" ||
      action.type === "home" ||
      action.type === "end";

    this.#editor.apply(action, columns, Math.min(columns, promptWidth));
    const renderedAfter = this.#editor.render(columns, this.#prompt);
    const eraseInline =
      inlineEraseCandidate && canEraseInline(renderedBefore.cursor, renderedAfter.cursor);

    if (appendAtEnd) {
      this.#output.write(action.type === "character" ? action.value : "\n");
      this.#cursor = renderedAfter.cursor;
    } else if (eraseInline) {
      this.#output.write("\b \b");
      this.#cursor = renderedAfter.cursor;
    } else if (moveCursorOnly) {
      moveCursor(this.#cursor, renderedAfter.cursor, this.#output);
      this.#cursor = renderedAfter.cursor;
    } else {
      this.#cursor = redraw(this.#editor, this.#cursor, this.#prompt, this.#output);
    }

    return { done: false };
  }
}

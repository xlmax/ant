import type { ConsoleInputAction } from "./windows-console-input.js";

export interface CursorPosition {
  row: number;
  column: number;
}

export interface RenderedEditor {
  text: string;
  cursor: CursorPosition;
  end: CursorPosition;
}

function positionFor(characters: readonly string[], columns: number): CursorPosition[] {
  const positions: CursorPosition[] = [{ row: 0, column: 0 }];
  let row = 0;
  let column = 0;

  for (const character of characters) {
    if (character === "\n") {
      row += 1;
      column = 0;
    } else {
      if (column >= columns) {
        row += 1;
        column = 0;
      }
      column += 1;
    }
    positions.push({ row, column });
  }

  return positions;
}

export class TextEditor {
  #characters: string[] = [];
  #cursor = 0;

  get value(): string {
    return this.#characters.join("");
  }

  get cursorAtEnd(): boolean {
    return this.#cursor === this.#characters.length;
  }

  get characterBeforeCursor(): string | undefined {
    return this.#characters[this.#cursor - 1];
  }

  replace(value: string): void {
    this.#characters = Array.from(value);
    this.#cursor = this.#characters.length;
  }

  apply(action: ConsoleInputAction, columns: number): void {
    switch (action.type) {
      case "character":
        this.#characters.splice(this.#cursor, 0, action.value);
        this.#cursor += 1;
        return;

      case "newline":
        this.#characters.splice(this.#cursor, 0, "\n");
        this.#cursor += 1;
        return;

      case "backspace":
        if (this.#cursor > 0) {
          this.#characters.splice(this.#cursor - 1, 1);
          this.#cursor -= 1;
        }
        return;

      case "delete":
        this.#characters.splice(this.#cursor, 1);
        return;

      case "left":
        this.#cursor = Math.max(0, this.#cursor - 1);
        return;

      case "right":
        this.#cursor = Math.min(this.#characters.length, this.#cursor + 1);
        return;

      case "home":
        while (this.#cursor > 0 && this.#characters[this.#cursor - 1] !== "\n") {
          this.#cursor -= 1;
        }
        return;

      case "end":
        while (this.#cursor < this.#characters.length && this.#characters[this.#cursor] !== "\n") {
          this.#cursor += 1;
        }
        return;

      case "up":
      case "down": {
        const positions = positionFor(this.#characters, columns);
        const current = positions[this.#cursor] ?? { row: 0, column: 0 };
        const targetRow = current.row + (action.type === "up" ? -1 : 1);

        if (targetRow < 0) {
          return;
        }

        const candidate = positions
          .map((position, index) => ({ position, index }))
          .filter(({ position }) => position.row === targetRow)
          .sort(
            (left, right) =>
              Math.abs(left.position.column - current.column) -
              Math.abs(right.position.column - current.column),
          )[0];

        if (candidate) {
          this.#cursor = candidate.index;
        }
        return;
      }

      case "submit":
      case "cancel":
      case "ignore":
        return;
    }
  }

  render(columns: number): RenderedEditor {
    const safeColumns = Math.max(1, columns);
    const positions = positionFor(this.#characters, safeColumns);
    let text = "";
    let column = 0;

    for (const character of this.#characters) {
      if (character === "\n") {
        text += "\n";
        column = 0;
        continue;
      }

      if (column >= safeColumns) {
        text += "\n";
        column = 0;
      }

      text += character;
      column += 1;
    }

    const cursor = positions[this.#cursor] ?? { row: 0, column: 0 };
    const end = positions[this.#characters.length] ?? { row: 0, column: 0 };
    return { text, cursor, end };
  }
}

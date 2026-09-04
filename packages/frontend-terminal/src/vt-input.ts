import { StringDecoder } from "node:string_decoder";

import {
  isPrintableCodePoint,
  type ConsoleInputAction,
  type TerminalInputEvent,
} from "./console-input-action.js";

const ESCAPE = "\u001B";
const PASTE_START = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;

export type VtInputEvent = TerminalInputEvent;

function normalizePastedText(value: string): string {
  const normalized = value.replace(/\r\n|\r/gu, "\n").replace(/\t/gu, "    ");
  return Array.from(normalized)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === "\n" || isPrintableCodePoint(codePoint);
    })
    .join("");
}

function csiAction(sequence: string): ConsoleInputAction {
  const final = sequence.at(-1);
  const parameters = sequence
    .slice(2, -1)
    .split(";")
    .map((part) => Number.parseInt(part, 10));

  switch (final) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "C":
      return { type: "right" };
    case "D":
      return { type: "left" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    case "~": {
      const [key, modifier, modifiedKey] = parameters;
      if (key === 1 || key === 7) return { type: "home" };
      if (key === 3) return { type: "delete" };
      if (key === 4 || key === 8) return { type: "end" };
      if (key === 27 && modifiedKey === 13 && (modifier ?? 1) > 1) {
        return { type: "newline" };
      }
      return { type: "ignore" };
    }
    case "u": {
      const [codePoint, modifier = 1] = parameters;
      if (codePoint === 10) return { type: "newline" };
      if (codePoint === 13) return modifier > 1 ? { type: "newline" } : { type: "submit" };
      // Kitty's keyboard protocol may encode Ctrl+J as modified "j".
      if (codePoint === 106 && ((modifier - 1) & 4) !== 0) return { type: "newline" };
      return { type: "ignore" };
    }
    default:
      return { type: "ignore" };
  }
}

function ss3Action(sequence: string): ConsoleInputAction {
  switch (sequence.at(-1)) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "C":
      return { type: "right" };
    case "D":
      return { type: "left" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    default:
      return { type: "ignore" };
  }
}

/** Incremental decoder for VT input used by PTYs and terminal emulators. */
export class VtInputDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #pasteBuffer = "";
  #pasting = false;

  write(chunk: Buffer | string): VtInputEvent[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#parse(false);
  }

  end(chunk?: Buffer): VtInputEvent[] {
    this.#buffer += chunk === undefined ? this.#decoder.end() : this.#decoder.end(chunk);
    return this.#parse(true);
  }

  #parse(flush: boolean): VtInputEvent[] {
    const events: VtInputEvent[] = [];

    while (this.#buffer !== "") {
      if (this.#pasting) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.#pasteBuffer += this.#buffer.slice(0, end);
          this.#buffer = this.#buffer.slice(end + PASTE_END.length);
          events.push({ type: "paste", value: normalizePastedText(this.#pasteBuffer) });
          this.#pasteBuffer = "";
          this.#pasting = false;
          continue;
        }

        const retained = flush ? 0 : Math.min(PASTE_END.length - 1, this.#buffer.length);
        const consumed = this.#buffer.length - retained;
        this.#pasteBuffer += this.#buffer.slice(0, consumed);
        this.#buffer = this.#buffer.slice(consumed);

        if (flush) {
          events.push({ type: "paste", value: normalizePastedText(this.#pasteBuffer) });
          this.#pasteBuffer = "";
          this.#pasting = false;
        }
        break;
      }

      if (this.#buffer.startsWith(PASTE_START)) {
        this.#buffer = this.#buffer.slice(PASTE_START.length);
        this.#pasting = true;
        continue;
      }
      if (!flush && PASTE_START.startsWith(this.#buffer)) break;

      if (this.#buffer.startsWith(`${ESCAPE}[`)) {
        const finalIndex = Array.from(this.#buffer.slice(2)).findIndex((character) =>
          /[@-~]/u.test(character),
        );
        if (finalIndex < 0) {
          if (!flush) break;
          this.#buffer = "";
          break;
        }
        const sequenceLength = finalIndex + 3;
        const sequence = this.#buffer.slice(0, sequenceLength);
        this.#buffer = this.#buffer.slice(sequenceLength);
        events.push({ type: "action", action: csiAction(sequence) });
        continue;
      }

      if (this.#buffer.startsWith(`${ESCAPE}O`)) {
        if (this.#buffer.length < 3) {
          if (!flush) break;
          this.#buffer = "";
          break;
        }
        const sequence = this.#buffer.slice(0, 3);
        this.#buffer = this.#buffer.slice(3);
        events.push({ type: "action", action: ss3Action(sequence) });
        continue;
      }

      if (this.#buffer.startsWith(`${ESCAPE}\r`) || this.#buffer.startsWith(`${ESCAPE}\n`)) {
        this.#buffer = this.#buffer.slice(2);
        events.push({ type: "action", action: { type: "newline" } });
        continue;
      }

      if (this.#buffer === ESCAPE && !flush) break;
      if (this.#buffer.startsWith(ESCAPE)) {
        // Preserve the printable part of Alt+character while discarding the modifier.
        this.#buffer = this.#buffer.slice(1);
        continue;
      }

      const [character = ""] = Array.from(this.#buffer);
      this.#buffer = this.#buffer.slice(character.length);

      switch (character) {
        case "\r":
          events.push({ type: "action", action: { type: "submit" } });
          break;
        case "\n":
          events.push({ type: "action", action: { type: "newline" } });
          break;
        case "\u0003":
          events.push({ type: "action", action: { type: "cancel" } });
          break;
        case "\u0004":
          events.push({ type: "action", action: { type: "eof" } });
          break;
        case "\b":
        case "\u007F":
          events.push({ type: "action", action: { type: "backspace" } });
          break;
        default: {
          const codePoint = character.codePointAt(0);
          events.push({
            type: "action",
            action:
              codePoint !== undefined && isPrintableCodePoint(codePoint)
                ? { type: "character", value: character }
                : { type: "ignore" },
          });
        }
      }
    }

    return events;
  }
}

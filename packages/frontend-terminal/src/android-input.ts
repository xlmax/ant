import { StringDecoder } from "node:string_decoder";

import type { ConsoleInputAction } from "./windows-console-input.js";

const ESCAPE = "\u001B";
const PASTE_START = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;

const ESCAPE_ACTIONS = new Map<string, ConsoleInputAction>([
  [`${ESCAPE}\r`, { type: "newline" }],
  [`${ESCAPE}\n`, { type: "newline" }],
  [`${ESCAPE}[A`, { type: "up" }],
  [`${ESCAPE}[B`, { type: "down" }],
  [`${ESCAPE}[C`, { type: "right" }],
  [`${ESCAPE}[D`, { type: "left" }],
  [`${ESCAPE}[H`, { type: "home" }],
  [`${ESCAPE}[F`, { type: "end" }],
  [`${ESCAPE}[1~`, { type: "home" }],
  [`${ESCAPE}[3~`, { type: "delete" }],
  [`${ESCAPE}[4~`, { type: "end" }],
]);

const ESCAPE_SEQUENCES = [PASTE_START, ...ESCAPE_ACTIONS.keys()];

export type AndroidInputEvent =
  { type: "action"; action: ConsoleInputAction } | { type: "paste"; value: string };

function normalizePastedNewlines(value: string): string {
  return value.replace(/\r\n|\r/gu, "\n");
}

/** Incremental decoder for the VT sequences emitted by Termux. */
export class AndroidInputDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #pasteBuffer = "";
  #pasting = false;

  write(chunk: Buffer | string): AndroidInputEvent[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#parse(false);
  }

  end(chunk?: Buffer): AndroidInputEvent[] {
    this.#buffer += chunk === undefined ? this.#decoder.end() : this.#decoder.end(chunk);
    return this.#parse(true);
  }

  #parse(flush: boolean): AndroidInputEvent[] {
    const events: AndroidInputEvent[] = [];

    while (this.#buffer !== "") {
      if (this.#pasting) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.#pasteBuffer += this.#buffer.slice(0, end);
          this.#buffer = this.#buffer.slice(end + PASTE_END.length);
          events.push({ type: "paste", value: normalizePastedNewlines(this.#pasteBuffer) });
          this.#pasteBuffer = "";
          this.#pasting = false;
          continue;
        }

        const retained = flush ? 0 : Math.min(PASTE_END.length - 1, this.#buffer.length);
        const consumed = this.#buffer.length - retained;
        this.#pasteBuffer += this.#buffer.slice(0, consumed);
        this.#buffer = this.#buffer.slice(consumed);

        if (flush) {
          events.push({ type: "paste", value: normalizePastedNewlines(this.#pasteBuffer) });
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

      const escapeAction = [...ESCAPE_ACTIONS].find(([sequence]) =>
        this.#buffer.startsWith(sequence),
      );
      if (escapeAction) {
        this.#buffer = this.#buffer.slice(escapeAction[0].length);
        events.push({ type: "action", action: escapeAction[1] });
        continue;
      }

      if (
        !flush &&
        this.#buffer.startsWith(ESCAPE) &&
        ESCAPE_SEQUENCES.some((sequence) => sequence.startsWith(this.#buffer))
      ) {
        break;
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
        case "\b":
        case "\u007F":
          events.push({ type: "action", action: { type: "backspace" } });
          break;
        case ESCAPE:
          break;
        default: {
          const codePoint = character.codePointAt(0);
          events.push({
            type: "action",
            action:
              codePoint !== undefined && codePoint >= 32
                ? { type: "character", value: character }
                : { type: "ignore" },
          });
        }
      }
    }

    return events;
  }
}

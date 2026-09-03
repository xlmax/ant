import { on } from "node:events";
import { stdin, stdout } from "node:process";
import { StringDecoder } from "node:string_decoder";

interface SecretInputStream extends NodeJS.EventEmitter {
  readonly isRaw?: boolean;
  readonly isTTY?: boolean;
  readonly readableFlowing?: boolean | null;
  pause(): this;
  resume(): this;
  setRawMode(mode: boolean): this;
}

interface SecretOutputStream {
  readonly isTTY?: boolean;
  write(value: string): unknown;
}

export interface HiddenTerminalInputOptions {
  input?: SecretInputStream;
  output?: SecretOutputStream;
  hidden?: boolean;
}

export async function readTerminalPrompt(
  prompt: string,
  options: HiddenTerminalInputOptions = {},
): Promise<string | undefined> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  if (!input.isTTY || !output.isTTY) throw new Error("Интерактивный ввод недоступен");

  const originalRawMode = Boolean(input.isRaw);
  const originallyFlowing = input.readableFlowing === true;
  const eventsAbort = new AbortController();
  const decoder = new StringDecoder("utf8");
  let value = "";
  let escapeSequence = false;
  let rawModeChanged = false;

  try {
    input.setRawMode(true);
    rawModeChanged = true;
    output.write(prompt);
    const chunks = on(input, "data", {
      close: ["end", "close"],
      signal: eventsAbort.signal,
    });
    input.resume();

    for await (const [chunk] of chunks) {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      for (const character of text) {
        if (escapeSequence) {
          if (/[@-~]/u.test(character) && character !== "[") escapeSequence = false;
          continue;
        }
        if (character === "\u001B") {
          escapeSequence = true;
          continue;
        }
        if (character === "\u0003") {
          output.write("\n");
          return undefined;
        }
        if (character === "\r" || character === "\n") {
          output.write("\n");
          return value;
        }
        if (character === "\u007F" || character === "\b") {
          const characters = Array.from(value);
          if (characters.length > 0) {
            characters.pop();
            value = characters.join("");
            output.write("\b \b");
          }
          continue;
        }
        if (character < " ") continue;
        value += character;
        output.write(options.hidden === false ? character : "*");
      }
    }

    throw new Error("Поток терминального ввода завершён");
  } finally {
    eventsAbort.abort();
    try {
      if (rawModeChanged) input.setRawMode(originalRawMode);
    } finally {
      if (!originallyFlowing) input.pause();
    }
  }
}

export function readHiddenTerminalInput(
  prompt: string,
  options: Omit<HiddenTerminalInputOptions, "hidden"> = {},
): Promise<string | undefined> {
  return readTerminalPrompt(prompt, options);
}

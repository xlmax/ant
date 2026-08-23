import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  createAgentState,
  runAgent,
  type AgentModel,
  type AgentState,
} from "../core/agent.js";
import type { ToolEnvironment } from "../core/environment.js";
import {
  JsonlSessionStore,
  type AgentSession,
} from "../core/session-store.js";
import { ansi } from "./ansi.js";
import { getReplCommands, parseReplCommand } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { InputHistory } from "./input-history.js";
import { readTerminalInput } from "./terminal-input.js";
import {
  closeUserInputFrame,
  openUserInputFrame,
  userInputPrompt,
} from "./input-frame.js";

const TURN_TIMEOUT_MS = 60_000;

export interface ReplOptions {
  model: AgentModel;
  environment: ToolEnvironment;
  store: JsonlSessionStore;
  resume?: string;
}

async function appendUserMessage(
  state: AgentState,
  session: AgentSession,
  content: string,
): Promise<void> {
  const event = { type: "user" as const, content };
  state.events.push(event);
  await session.observer.onEvent(event);
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const terminal =
    process.platform === "win32" && stdin.isTTY
      ? undefined
      : createInterface({ input: stdin, output: stdout });
  const renderer = new ConsoleRenderer();
  const inputHistory = new InputHistory();
  let state: AgentState | undefined;
  let session: AgentSession | undefined;

  if (options.resume) {
    const resumed = await options.store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;
    console.log(ansi.dim(`Продолжена сессия: ${session.id}`));
  } else {
    console.log(
      ansi.dim("Интерактивный режим. Введите /help, чтобы увидеть команды."),
    );
  }

  try {
    while (true) {
      openUserInputFrame();
      stdout.write(userInputPrompt());
      const input = await readTerminalInput(inputHistory, terminal);
      closeUserInputFrame();

      if (input.trim() === "") {
        continue;
      }

      const command = parseReplCommand(input.trim());

      if (command) {
        switch (command.type) {
          case "exit":
            return;

          case "new":
            state = undefined;
            session = undefined;
            console.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
            continue;

          case "session":
            console.log(
              session
                ? ansi.dim(`Сессия: ${session.id}\nФайл: ${session.filePath}`)
                : ansi.dim("Сессия ещё не создана."),
            );
            continue;

          case "clear":
            process.stdout.write("\u001B[2J\u001B[H");
            continue;

          case "help":
            if (command.command) {
              console.log(
                `${ansi.bold(command.command.usage)}\n${command.command.description}`,
              );
            } else {
              console.log(ansi.bold("Доступные команды:"));
              for (const available of getReplCommands()) {
                console.log(
                  `  ${ansi.cyan(available.usage.padEnd(20))} ${available.description}`,
                );
              }
            }
            continue;

          case "error":
            console.error(ansi.red(command.message));
            continue;
        }
      }

      inputHistory.add(input);

      if (!state || !session) {
        state = createAgentState(input);
        session = await options.store.create(state);
        console.log(ansi.dim(`Сессия: ${session.id}`));
      } else {
        await appendUserMessage(state, session, input);
      }

      renderer.beginTurn();
      const result = await runAgent(state, {
        model: options.model,
        environment: options.environment,
        observers: [session.observer, renderer],
        onTextDelta: renderer.onTextDelta,
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });

      renderer.printResult(result);
    }
  } finally {
    terminal?.close();
  }
}

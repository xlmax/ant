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
import { ConsoleRenderer } from "./console-renderer.js";
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
  const terminal = createInterface({ input: stdin, output: stdout });
  const renderer = new ConsoleRenderer();
  let state: AgentState | undefined;
  let session: AgentSession | undefined;

  if (options.resume) {
    const resumed = await options.store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;
    console.log(ansi.dim(`Продолжена сессия: ${session.id}`));
  } else {
    console.log(
      ansi.dim("Интерактивный режим. Команды: /new, /session, /exit"),
    );
  }

  try {
    while (true) {
      openUserInputFrame();
      const input = (await terminal.question(userInputPrompt())).trim();
      closeUserInputFrame();

      if (!input) {
        continue;
      }

      if (input === "/exit") {
        return;
      }

      if (input === "/new") {
        state = undefined;
        session = undefined;
        console.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
        continue;
      }

      if (input === "/session") {
        console.log(
          session
            ? ansi.dim(`Сессия: ${session.id}\nФайл: ${session.filePath}`)
            : ansi.dim("Сессия ещё не создана."),
        );
        continue;
      }

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
    terminal.close();
  }
}

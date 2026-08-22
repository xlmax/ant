import {
  createAgentState,
  runAgent,
  type AgentEvent,
  type AgentState,
} from "./agent.js";
import { createBashTool } from "./bash-tool.js";
import { ToolEnvironment, type Tool } from "./environment.js";
import { createEditTool } from "./edit-tool.js";
import { DeepSeekModel } from "./models/deepseek-model.js";
import { createReadTool } from "./read-tool.js";
import { createWriteTool } from "./write-tool.js";
import { JsonlSessionStore, type AgentSession } from "./session-store.js";
import { join } from "node:path";

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "task":
      console.log(`Задача: ${event.content}`);
      break;

    case "user":
      console.log(`Пользователь: ${event.content}`);
      break;

    case "decision":
      if (event.decision.type === "tools") {
        for (const call of event.decision.calls) {
          console.log(
            `Модель запросила: ${call.name} (${call.id}) ${formatValue(
              call.input,
            )}`,
          );
        }
      }
      break;

    case "observation":
      console.log(
        event.observation.ok
          ? `Результат инструмента: ${formatValue(event.observation.value)}`
          : `Ошибка инструмента: ${event.observation.error}`,
      );
      break;
  }
}

interface CliOptions {
  task: string;
  resume?: string;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const taskParts: string[] = [];
  let resume: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--resume") {
      const sessionId = args[index + 1];

      if (!sessionId) {
        throw new Error("Для --resume нужно указать идентификатор сессии");
      }

      resume = sessionId;
      index += 1;
      continue;
    }

    if (argument !== undefined) {
      taskParts.push(argument);
    }
  }

  return {
    task: taskParts.join(" ").trim(),
    ...(resume === undefined ? {} : { resume }),
  };
}

function createModel(): DeepSeekModel {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Для DeepSeek необходимо задать переменную DEEPSEEK_API_KEY",
    );
  }

  return new DeepSeekModel({
    apiKey,
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    baseUrl:
      process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  });
}

function createTools(): Tool[] {
  const workspace = process.cwd();
  return [
    createReadTool(workspace),
    createBashTool(workspace),
    createEditTool(workspace),
    createWriteTool(workspace),
  ];
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (!options.task) {
    console.error(
      'Использование: npm run dev -- [--resume <session-id>] "текст задачи"',
    );
    process.exitCode = 1;
    return;
  }

  const model = createModel();
  const store = new JsonlSessionStore(
    join(process.cwd(), ".agent", "sessions"),
  );
  let state: AgentState;
  let session: AgentSession;

  if (options.resume) {
    const resumed = await store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;

    const event = { type: "user" as const, content: options.task };
    state.events.push(event);
    await session.observer.onEvent(event);
  } else {
    state = createAgentState(options.task);
    session = await store.create(state);
  }

  console.log(`Сессия: ${session.id}`);

  const result = await runAgent(state, {
    model,
    environment: new ToolEnvironment(createTools()),
    observers: [session.observer],
    signal: AbortSignal.timeout(60_000),
  });

  for (const event of result.state.events) {
    printEvent(event);
  }

  switch (result.status) {
    case "completed":
      console.log(`Ответ: ${result.answer}`);
      break;

    case "waiting":
      console.log(`Вопрос: ${result.question}`);
      break;

    case "cancelled":
      console.error("Работа агента отменена");
      process.exitCode = 2;
      break;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

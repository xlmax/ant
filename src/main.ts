import { createAgentState, runAgent, type AgentEvent } from "./agent.js";
import { createBashTool } from "./bash-tool.js";
import { ToolEnvironment, type Tool } from "./environment.js";
import { createEditTool } from "./edit-tool.js";
import { DeepSeekModel } from "./models/deepseek-model.js";
import { createReadTool } from "./read-tool.js";
import { createWriteTool } from "./write-tool.js";

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
  const task = process.argv.slice(2).join(" ").trim();

  if (!task) {
    console.error('Использование: npm run dev -- "текст задачи"');
    process.exitCode = 1;
    return;
  }

  const state = createAgentState(task);
  const result = await runAgent(state, {
    model: createModel(),
    environment: new ToolEnvironment(createTools()),
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

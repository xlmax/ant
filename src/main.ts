import { join } from "node:path";

import {
  createAgentState,
  runAgent,
  type AgentState,
} from "./core/agent.js";
import { createCodingTools } from "./coding-tools.js";
import { loadSettings } from "./config/settings.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { ToolEnvironment } from "./core/environment.js";
import {
  JsonlSessionStore,
  type AgentSession,
} from "./core/session-store.js";
import { DeepSeekModel } from "./models/deepseek-model.js";
import { ConsoleRenderer } from "./ui/console-renderer.js";
import { runRepl } from "./ui/repl.js";

const TURN_TIMEOUT_MS = 60_000;

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

async function createModel(workspace: string): Promise<{
  model: DeepSeekModel;
  promptSources: string[];
  showReasoning: boolean;
}> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Для DeepSeek необходимо задать переменную DEEPSEEK_API_KEY",
    );
  }

  const [systemPrompt, loadedSettings] = await Promise.all([
    loadSystemPrompt(workspace),
    loadSettings(workspace),
  ]);

  return {
    model: new DeepSeekModel({
      apiKey,
      systemPrompt: systemPrompt.content,
      model: loadedSettings.settings.model.id,
      baseUrl: loadedSettings.settings.model.baseUrl,
      contextWindow: loadedSettings.settings.model.contextWindow,
      thinkingEnabled: loadedSettings.settings.model.thinking.enabled,
      reasoningEffort: loadedSettings.settings.model.thinking.effort,
    }),
    promptSources: systemPrompt.sources,
    showReasoning: loadedSettings.settings.ui.showReasoning,
  };
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

async function runOneShot(
  options: CliOptions,
  model: DeepSeekModel,
  environment: ToolEnvironment,
  store: JsonlSessionStore,
  showReasoning: boolean,
): Promise<void> {
  let state: AgentState;
  let session: AgentSession;

  if (options.resume) {
    const resumed = await store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;
    await appendUserMessage(state, session, options.task);
  } else {
    state = createAgentState(options.task);
    session = await store.create(state);
  }

  const renderer = new ConsoleRenderer({ showReasoning });
  console.log(`Сессия: ${session.id}`);
  renderer.beginTurn();

  const result = await runAgent(state, {
    model,
    environment,
    observers: [session.observer, renderer],
    onTextDelta: renderer.onTextDelta,
    onReasoningDelta: renderer.onReasoningDelta,
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });

  renderer.printResult(result);

  if (result.status === "cancelled") {
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const workspace = process.cwd();
  const { model, promptSources, showReasoning } = await createModel(workspace);
  const environment = new ToolEnvironment(createCodingTools(workspace));
  const store = new JsonlSessionStore(join(workspace, ".agent", "sessions"));

  console.log(`Системный промпт: ${promptSources.join(", ")}`);

  if (!options.task) {
    await runRepl({
      model,
      environment,
      store,
      showReasoning,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    });
    return;
  }

  await runOneShot(options, model, environment, store, showReasoning);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

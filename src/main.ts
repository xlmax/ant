#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

import { cliHelp, parseCliOptions, type CliOptions } from "./cli-options.js";
import { VERSION } from "./version.js";
import type {
  ModelSettings,
  ProjectSettingsOverrides,
  RuntimeLimits,
  VerificationSettings,
} from "./config/settings.js";
import { createCodingTools } from "./coding-tools.js";
import {
  loadSettings,
  readExplicitVision,
  resolveVision,
  saveUserModelId,
  saveUserModelThinking,
  saveUserShowReasoning,
} from "./config/settings.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { ToolEnvironment } from "./core/environment.js";
import { JsonlSessionStore } from "./core/session-store.js";
import { SessionController } from "./core/session-controller.js";
import type { ContextSummarizer } from "./core/context-events.js";
import { DeepSeekModel } from "./models/deepseek-model.js";
import { configureAnsi } from "./ui/ansi.js";
import { ConsoleRenderer } from "./ui/console-renderer.js";
import { runRepl } from "./ui/repl.js";
import { initConsoleSize } from "./ui/console-size.js";
import { TurnRunner } from "./ui/turn-runner.js";

function createDeepSeekModel(
  apiKey: string,
  systemPrompt: string,
  settings: ModelSettings,
): DeepSeekModel {
  return new DeepSeekModel({
    apiKey,
    systemPrompt,
    model: settings.id,
    baseUrl: settings.baseUrl,
    contextWindow: settings.contextWindow,
    supportsImages: settings.vision,
    thinkingEnabled: settings.thinking.enabled,
    reasoningEffort: settings.thinking.effort,
  });
}

async function createModel(workspace: string): Promise<{
  model: DeepSeekModel;
  summarizer: ContextSummarizer;
  modelSettings: ModelSettings;
  createAgentModel(settings: ModelSettings): DeepSeekModel;
  createContextSummarizer(settings: ModelSettings): ContextSummarizer;
  listModels(): Promise<readonly string[]>;
  saveModelId(id: string): Promise<boolean>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveShowReasoning(enabled: boolean): Promise<void>;
  systemPrompt: string;
  projectOverrides: ProjectSettingsOverrides;
  showReasoning: boolean;
  showChanges: boolean;
  color: boolean;
  limits: RuntimeLimits;
  verification: VerificationSettings;
  bashPath?: string;
}> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Для DeepSeek необходимо задать переменную DEEPSEEK_API_KEY");
  }

  const loadedSettings = await loadSettings(workspace);
  const systemPrompt = await loadSystemPrompt(
    workspace,
    loadedSettings.settings.prompts.additionalPaths,
  );

  // `model.vision` is already resolved at load time (explicit setting wins,
  // heuristic is the fallback), so the settings are the single source of truth.
  const modelSettings = loadedSettings.settings.model;
  const createConfiguredModel = (settings: ModelSettings): DeepSeekModel =>
    createDeepSeekModel(apiKey, systemPrompt.content, settings);

  const model = createConfiguredModel(modelSettings);

  // Persist the id, then return only the vision for the newly selected model.
  // This deliberately avoids reloading the merged config: a project-level
  // `model.id` must not clobber the runtime switch (it only warns about
  // overriding on the next restart). The explicit `model.vision` provenance is
  // read separately so the heuristic is applied only when no layer set it.
  const saveModelId = async (id: string): Promise<boolean> => {
    await saveUserModelId(id);
    return resolveVision(id, await readExplicitVision(workspace));
  };

  return {
    model,
    summarizer: model,
    modelSettings,
    createAgentModel: createConfiguredModel,
    createContextSummarizer: createConfiguredModel,
    listModels: () => model.listModels(),
    saveModelId,
    saveThinking: saveUserModelThinking,
    saveShowReasoning: saveUserShowReasoning,
    systemPrompt: systemPrompt.content,
    projectOverrides: loadedSettings.projectOverrides,
    showReasoning: loadedSettings.settings.ui.showReasoning,
    showChanges: loadedSettings.settings.ui.showChanges,
    color: loadedSettings.settings.ui.color,
    limits: loadedSettings.settings.limits,
    verification: loadedSettings.settings.verification,
    ...(loadedSettings.settings.tools.bashPath === undefined
      ? {}
      : { bashPath: loadedSettings.settings.tools.bashPath }),
  };
}

async function runOneShot(
  options: Pick<CliOptions, "task" | "resume">,
  workspace: string,
  model: DeepSeekModel,
  environment: ToolEnvironment,
  store: JsonlSessionStore,
  showReasoning: boolean,
  showChanges: boolean,
  limits: RuntimeLimits,
  verification: VerificationSettings,
): Promise<void> {
  const sessions = new SessionController(store);
  if (options.resume) await sessions.resume(options.resume);
  const prepared = await sessions.prepareUserMessage(options.task);
  const { state, session } = prepared;

  const renderer = new ConsoleRenderer({ showReasoning });
  console.log(`Сессия: ${session.id}`);

  const result = await new TurnRunner({
    workspace,
    model,
    environment,
    renderer,
    session,
    limits,
    verification,
    showChanges,
  }).run(state);

  if (result.status === "cancelled") {
    process.exitCode = 2;
  }
}

function formatSessionTask(task: string): string {
  const singleLine = task.replace(/\s+/gu, " ").trim();
  const characters = Array.from(singleLine);
  return characters.length <= 80 ? singleLine : `${characters.slice(0, 77).join("")}…`;
}

async function resolveResumeId(
  options: CliOptions,
  store: JsonlSessionStore,
): Promise<string | undefined> {
  if (!options.continueLatest) {
    return options.resume;
  }

  const latest = (await store.list()).sessions[0];
  if (!latest) {
    throw new Error("Нет сохранённых сессий для продолжения");
  }

  return latest.id;
}

async function printSessionList(store: JsonlSessionStore): Promise<void> {
  const { sessions, warnings } = await store.list();
  for (const warning of warnings) {
    console.error(`Предупреждение: ${warning}`);
  }
  if (sessions.length === 0) {
    console.log("Сохранённых сессий нет.");
    return;
  }

  console.log("Сохранённые сессии:");
  for (const session of sessions) {
    console.log(`${session.id} · ${session.updatedAt} · ${formatSessionTask(session.task)}`);
  }
}

function loadOptionalEnv(path: string): void {
  try {
    loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function loadLocalEnv(workspace: string): void {
  // Project first so it wins over the global fallback: loadEnvFile does not
  // overwrite already-set variables, and the real environment wins over both.
  loadOptionalEnv(resolve(workspace, ".env.local"));
  loadOptionalEnv(resolve(homedir(), ".ant", ".env.local"));
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  loadLocalEnv(workspace);

  const options = parseCliOptions(process.argv.slice(2));
  if (options.action === "help") {
    console.log(cliHelp());
    return;
  }

  if (options.action === "version") {
    console.log(VERSION);
    return;
  }

  const store = new JsonlSessionStore(join(workspace, ".ant", "sessions"));
  if (options.action === "list-sessions") {
    await printSessionList(store);
    return;
  }

  const resume = await resolveResumeId(options, store);
  const {
    model,
    summarizer,
    modelSettings,
    createAgentModel: createConfiguredModel,
    createContextSummarizer,
    listModels,
    saveModelId,
    saveThinking,
    saveShowReasoning,
    systemPrompt,
    projectOverrides,
    showReasoning,
    showChanges,
    color,
    limits,
    verification,
    bashPath,
  } = await createModel(workspace);
  configureAnsi(color);
  await initConsoleSize();
  const environment = new ToolEnvironment(
    createCodingTools(workspace, bashPath === undefined ? {} : { bashPath }),
  );

  if (!options.task) {
    await runRepl({
      workspace,
      model,
      summarizer,
      modelSettings,
      createAgentModel: createConfiguredModel,
      createContextSummarizer,
      listModels,
      saveModelId,
      saveThinking,
      saveShowReasoning,
      projectOverrides,
      environment,
      store,
      showReasoning,
      showChanges,
      limits,
      verification,
      systemPrompt,
      ...(resume === undefined ? {} : { resume }),
    });
    return;
  }

  await runOneShot(
    { task: options.task, ...(resume === undefined ? {} : { resume }) },
    workspace,
    model,
    environment,
    store,
    showReasoning,
    showChanges,
    limits,
    verification,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

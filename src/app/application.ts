import { join } from "node:path";

import { cliHelp, parseCliOptions, type CliOptions } from "../cli-options.js";
import type { SettingsModule } from "../config/settings-module.js";
import type { SystemPrompt } from "../config/system-prompt.js";
import type { Environment } from "../core/agent.js";
import type { AgentRuntime } from "../core/runtime.js";
import type { SessionStore } from "../core/session.js";
import { VERSION } from "../version.js";
import { AntHost } from "./ant-host.js";
import type { AntFrontend, FrontendOptions } from "./frontend.js";
import type { ModelProvider } from "./model-provider.js";

export interface ProviderBootstrapOptions {
  systemPrompt: string;
}

export interface EnvironmentBootstrapOptions {
  bashPath?: string;
}

export interface ApplicationOutput {
  log(message: string): void;
  error(message: string): void;
}

export interface AntApplicationModules {
  runtime: AgentRuntime;
  settings: SettingsModule;
  applyEnvironment(workspace: string): void;
  loadSystemPrompt(workspace: string, additionalPaths: readonly string[]): Promise<SystemPrompt>;
  createProvider(options: ProviderBootstrapOptions): ModelProvider;
  createSessionStore(directory: string): SessionStore;
  createEnvironment(workspace: string, options: EnvironmentBootstrapOptions): Environment;
  createFrontend(options: FrontendOptions): AntFrontend;
  output: ApplicationOutput;
}

export interface AntApplicationRunOptions {
  workspace: string;
  args: readonly string[];
}

function formatSessionTask(task: string): string {
  const singleLine = task.replace(/\s+/gu, " ").trim();
  const characters = Array.from(singleLine);
  return characters.length <= 80 ? singleLine : `${characters.slice(0, 77).join("")}…`;
}

async function resolveResumeId(
  options: CliOptions,
  store: SessionStore,
): Promise<string | undefined> {
  if (!options.continueLatest) return options.resume;

  const latest = (await store.list()).sessions[0];
  if (!latest) throw new Error("Нет сохранённых сессий для продолжения");
  return latest.id;
}

async function printSessionList(store: SessionStore, output: ApplicationOutput): Promise<void> {
  const { sessions, warnings } = await store.list();
  for (const warning of warnings) output.error(`Предупреждение: ${warning}`);
  if (sessions.length === 0) {
    output.log("Сохранённых сессий нет.");
    return;
  }

  output.log("Сохранённые сессии:");
  for (const session of sessions) {
    output.log(`${session.id} · ${session.updatedAt} · ${formatSessionTask(session.task)}`);
  }
}

export class AntApplication {
  readonly #modules: AntApplicationModules;

  constructor(modules: AntApplicationModules) {
    this.#modules = modules;
  }

  async run(runOptions: AntApplicationRunOptions): Promise<void> {
    const { workspace } = runOptions;
    this.#modules.applyEnvironment(workspace);

    const options = parseCliOptions(runOptions.args);
    if (options.action === "help") {
      this.#modules.output.log(cliHelp());
      return;
    }
    if (options.action === "version") {
      this.#modules.output.log(VERSION);
      return;
    }

    const store = this.#modules.createSessionStore(join(workspace, ".ant", "sessions"));
    if (options.action === "list-sessions") {
      await printSessionList(store, this.#modules.output);
      return;
    }

    const resume = await resolveResumeId(options, store);
    const loadedSettings = await this.#modules.settings.load(workspace);
    const systemPrompt = await this.#modules.loadSystemPrompt(
      workspace,
      loadedSettings.settings.prompts.additionalPaths,
    );
    const modelSettings = loadedSettings.settings.model;
    const provider = this.#modules.createProvider({
      systemPrompt: systemPrompt.content,
    });

    // Persist the id, then resolve only vision for the runtime switch. Reloading
    // merged settings here would let a project model.id clobber the selection.
    const saveModelId = async (id: string): Promise<boolean> => {
      await this.#modules.settings.saveModelId(id);
      return this.#modules.settings.resolveVision(
        id,
        await this.#modules.settings.readExplicitVision(workspace),
      );
    };

    const environment = this.#modules.createEnvironment(
      workspace,
      loadedSettings.settings.tools.bashPath === undefined
        ? {}
        : { bashPath: loadedSettings.settings.tools.bashPath },
    );
    const host = new AntHost({
      runtime: this.#modules.runtime,
      provider,
      sessions: store,
      environment,
    });
    const frontend = this.#modules.createFrontend({
      task: options.task,
      workspace,
      color: loadedSettings.settings.ui.color,
      modelSettings,
      settings: {
        saveModelId,
        saveThinking: (thinking) => this.#modules.settings.saveThinking(thinking),
        saveShowReasoning: (enabled) => this.#modules.settings.saveShowReasoning(enabled),
      },
      projectOverrides: loadedSettings.projectOverrides,
      showReasoning: loadedSettings.settings.ui.showReasoning,
      showChanges: loadedSettings.settings.ui.showChanges,
      limits: loadedSettings.settings.limits,
      verification: loadedSettings.settings.verification,
      systemPrompt: systemPrompt.content,
      ...(resume === undefined ? {} : { resume }),
    });
    await host.run(frontend);
  }
}

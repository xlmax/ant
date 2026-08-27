import type { Environment } from "@ant/core";
import type { AgentRuntime } from "@ant/core";
import { AntApplicationClient } from "./application-client.js";
import {
  LIMIT_CONFIGURATION,
  MODEL_CONFIGURATION,
  PROMPT_CONFIGURATION,
  TOOL_CONFIGURATION,
  UI_CONFIGURATION,
  VERIFICATION_CONFIGURATION,
  type SettingsModule,
} from "./configuration.js";
import type { AntFrontend, FrontendOptions } from "./frontend.js";
import type { ModelProvider } from "./model-provider.js";
import type { SessionList, SessionStore } from "./session.js";
import type { SystemPrompt } from "./system-prompt.js";
import type { ModuleRegistry } from "./module-lifecycle.js";

export interface ProviderBootstrapOptions {
  systemPrompt: string;
}

export interface EnvironmentBootstrapOptions {
  bashPath?: string;
}

export interface AntApplicationModules {
  runtime: AgentRuntime;
  settings: SettingsModule;
  loadSystemPrompt(workspace: string, additionalPaths: readonly string[]): Promise<SystemPrompt>;
  createProvider(options: ProviderBootstrapOptions): ModelProvider;
  createSessionStore(workspace: string): SessionStore;
  createEnvironment(workspace: string, options: EnvironmentBootstrapOptions): Environment;
  createFrontend(options: FrontendOptions): AntFrontend;
  lifecycle?: ModuleRegistry;
}

export interface AntApplicationRunOptions {
  workspace: string;
  task: string;
  resume?: string;
  continueLatest?: boolean;
}

async function resolveResumeId(
  options: Pick<AntApplicationRunOptions, "continueLatest" | "resume">,
  store: SessionStore,
): Promise<string | undefined> {
  if (options.continueLatest !== true) return options.resume;

  const latest = (await store.list()).sessions[0];
  if (!latest) throw new Error("Нет сохранённых сессий для продолжения");
  return latest.id;
}

export class AntApplication {
  readonly #modules: AntApplicationModules;

  constructor(modules: AntApplicationModules) {
    this.#modules = modules;
  }

  listSessions(workspace: string): Promise<SessionList> {
    return this.#modules.createSessionStore(workspace).list();
  }

  async run(runOptions: AntApplicationRunOptions): Promise<void> {
    if (this.#modules.lifecycle) {
      await this.#modules.lifecycle.run(() => this.#run(runOptions));
      return;
    }
    await this.#run(runOptions);
  }

  async #run(runOptions: AntApplicationRunOptions): Promise<void> {
    const { workspace } = runOptions;
    const store = this.#modules.createSessionStore(workspace);
    const resume = await resolveResumeId(runOptions, store);
    const loadedSettings = await this.#modules.settings.load(workspace);
    const configuration = loadedSettings.configuration;
    const prompts = configuration.get(PROMPT_CONFIGURATION);
    const modelConfiguration = configuration.get(MODEL_CONFIGURATION);
    const tools = configuration.get(TOOL_CONFIGURATION);
    const limits = configuration.get(LIMIT_CONFIGURATION);
    const verification = configuration.get(VERIFICATION_CONFIGURATION);
    const ui = configuration.get(UI_CONFIGURATION);
    const systemPrompt = await this.#modules.loadSystemPrompt(workspace, prompts.additionalPaths);
    const provider = this.#modules.createProvider({
      systemPrompt: systemPrompt.content,
    });

    const environment = this.#modules.createEnvironment(
      workspace,
      tools.bashPath === undefined ? {} : { bashPath: tools.bashPath },
    );
    const client = new AntApplicationClient({
      runtime: this.#modules.runtime,
      provider,
      sessions: store,
      environment,
      systemPrompt: systemPrompt.content,
      modelConfiguration,
      settings: {
        saveModelId: (id) => this.#modules.settings.saveModelId(id),
        saveModelProviderOptions: (providerId, update) =>
          this.#modules.settings.saveModelProviderOptions(providerId, update),
      },
      limits,
      verification,
    });
    const frontend = this.#modules.createFrontend({
      task: runOptions.task,
      workspace,
      color: ui.color,
      settings: {
        saveReasoningMode: (mode) => this.#modules.settings.saveReasoningMode(mode),
      },
      projectOverrides: {
        modelId: configuration.isProjectOverride(MODEL_CONFIGURATION, "modelId"),
        modelThinking: configuration.isProjectOverride(MODEL_CONFIGURATION, "providerOptions"),
        reasoningMode: configuration.isProjectOverride(UI_CONFIGURATION, "reasoningMode"),
        showChanges: configuration.isProjectOverride(UI_CONFIGURATION, "showChanges"),
      },
      reasoningMode: ui.reasoningMode,
      reasoningMaxLines: ui.reasoningMaxLines,
      showChanges: ui.showChanges,
      ...(resume === undefined ? {} : { resume }),
    });
    await frontend.run(client);
  }
}

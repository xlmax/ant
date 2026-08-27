import type { Environment } from "../core/agent.js";
import type { AgentRuntime } from "../core/runtime.js";
import { AntApplicationClient } from "./application-client.js";
import type { SettingsModule } from "./configuration.js";
import type { AntFrontend, FrontendOptions } from "./frontend.js";
import type { ModelProvider } from "./model-provider.js";
import type { SessionList, SessionStore } from "./session.js";
import type { SystemPrompt } from "./system-prompt.js";

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
    const { workspace } = runOptions;
    const store = this.#modules.createSessionStore(workspace);
    const resume = await resolveResumeId(runOptions, store);
    const loadedSettings = await this.#modules.settings.load(workspace);
    const systemPrompt = await this.#modules.loadSystemPrompt(
      workspace,
      loadedSettings.settings.prompts.additionalPaths,
    );
    const modelConfiguration = loadedSettings.settings.model;
    const provider = this.#modules.createProvider({
      systemPrompt: systemPrompt.content,
    });

    const environment = this.#modules.createEnvironment(
      workspace,
      loadedSettings.settings.tools.bashPath === undefined
        ? {}
        : { bashPath: loadedSettings.settings.tools.bashPath },
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
      limits: loadedSettings.settings.limits,
      verification: loadedSettings.settings.verification,
    });
    const frontend = this.#modules.createFrontend({
      task: runOptions.task,
      workspace,
      color: loadedSettings.settings.ui.color,
      settings: {
        saveReasoningMode: (mode) => this.#modules.settings.saveReasoningMode(mode),
      },
      projectOverrides: loadedSettings.projectOverrides,
      reasoningMode: loadedSettings.settings.ui.reasoningMode,
      reasoningMaxLines: loadedSettings.settings.ui.reasoningMaxLines,
      showChanges: loadedSettings.settings.ui.showChanges,
      ...(resume === undefined ? {} : { resume }),
    });
    await frontend.run(client);
  }
}

import type {
  AgentModel,
  AgentObserver,
  AgentResult,
  Environment,
  HistoryEvent,
  ReasoningDeltaHandler,
  TextDeltaHandler,
} from "@ant/core";
import { estimateContextBudget, type ContextBudget } from "@ant/core";
import { createCompactionPlan, type ContextSummarizer } from "@ant/core";
import type { AgentRuntime } from "@ant/core";
import type { RuntimeLimits, VerificationSettings } from "./configuration.js";
import type { ModelConfiguration, ModelDescriptor, ModelProvider } from "./model-provider.js";
import { SessionController } from "./session-controller.js";
import type { AgentSession, SessionStore } from "./session.js";

export interface ApplicationSettingsCommands {
  saveModelId(id: string): Promise<void>;
  saveModelProviderOptions(providerId: string, update: unknown): Promise<void>;
}

export interface ApplicationClientDependencies {
  runtime: AgentRuntime;
  provider: ModelProvider;
  sessions: SessionStore;
  environment: Environment;
  systemPrompt: string;
  modelConfiguration: ModelConfiguration;
  settings: ApplicationSettingsCommands;
  limits: RuntimeLimits;
  verification?: VerificationSettings;
}

export interface SubmitTurnOptions {
  observers?: readonly AgentObserver[];
  onTextDelta?: TextDeltaHandler;
  onReasoningDelta?: ReasoningDeltaHandler;
  signal?: AbortSignal;
  onSessionPrepared?(session: AgentSession, created: boolean): void | Promise<void>;
}

export interface SubmittedTurn {
  created: boolean;
  session: AgentSession;
  result: AgentResult;
}

export interface ActiveSessionInfo {
  session: AgentSession;
}

export type ThinkingSelection = string;

export interface ModelSelectionResult {
  descriptor: ModelDescriptor;
  changed: boolean;
}

export type CompactionResult =
  | { status: "no-session" }
  | { status: "not-enough-history" }
  | { status: "not-smaller"; before: ContextBudget; after: ContextBudget }
  | {
      status: "compacted";
      before: ContextBudget;
      after: ContextBudget;
      retainedUserTurns: number;
    };

export interface CompactionOptions {
  signal?: AbortSignal;
  onStarted?(): void | Promise<void>;
}

/** Stable use-case surface consumed by presentation adapters. */
export interface AntApplicationApi {
  readonly modelDescriptor: ModelDescriptor;
  readonly activeSession: ActiveSessionInfo | undefined;
  resumeSession(sessionId: string): Promise<ActiveSessionInfo>;
  getLastTurnEvents(): readonly HistoryEvent[] | undefined;
  resetSession(): void;
  submitTurn(content: string, options?: SubmitTurnOptions): Promise<SubmittedTurn>;
  getContextStatus(): ContextBudget;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  selectModel(id: string): Promise<ModelSelectionResult>;
  selectThinking(selection: ThinkingSelection): Promise<ModelSelectionResult>;
  compactContext(options?: CompactionOptions): Promise<CompactionResult>;
}

/**
 * Stateful application API for one ANT invocation. It owns the active session,
 * model clients and use-case orchestration so presentation adapters do not have
 * to compose runtime infrastructure themselves.
 */
export class AntApplicationClient implements AntApplicationApi {
  readonly #runtime: AgentRuntime;
  readonly #provider: ModelProvider;
  readonly #environment: Environment;
  readonly #systemPrompt: string;
  readonly #settings: ApplicationSettingsCommands;
  readonly #limits: RuntimeLimits;
  readonly #verification: VerificationSettings | undefined;
  readonly #sessions: SessionController;
  #modelConfiguration: ModelConfiguration;
  #modelDescriptor: ModelDescriptor;
  #model: AgentModel;
  #summarizer: ContextSummarizer;

  constructor(dependencies: ApplicationClientDependencies) {
    this.#runtime = dependencies.runtime;
    this.#provider = dependencies.provider;
    this.#environment = dependencies.environment;
    this.#systemPrompt = dependencies.systemPrompt;
    this.#settings = dependencies.settings;
    this.#limits = dependencies.limits;
    this.#verification = dependencies.verification;
    this.#sessions = new SessionController(dependencies.sessions);
    if (dependencies.provider.id !== dependencies.modelConfiguration.providerId) {
      throw new Error(
        `Configured provider ${dependencies.modelConfiguration.providerId} does not match active provider ${dependencies.provider.id}`,
      );
    }
    this.#modelConfiguration = dependencies.modelConfiguration;
    this.#modelDescriptor = dependencies.provider.describe(dependencies.modelConfiguration);
    this.#model = dependencies.provider.createAgentModel(dependencies.modelConfiguration);
    this.#summarizer = dependencies.provider.createContextSummarizer(
      dependencies.modelConfiguration,
    );
  }

  get modelDescriptor(): ModelDescriptor {
    return this.#modelDescriptor;
  }

  get activeSession(): ActiveSessionInfo | undefined {
    const active = this.#sessions.active;
    return active === undefined ? undefined : { session: active.session };
  }

  async resumeSession(sessionId: string): Promise<ActiveSessionInfo> {
    const active = await this.#sessions.resume(sessionId);
    return { session: active.session };
  }

  getLastTurnEvents(): readonly HistoryEvent[] | undefined {
    return this.#sessions.getLastTurnEvents();
  }

  resetSession(): void {
    this.#sessions.reset();
  }

  async submitTurn(content: string, options: SubmitTurnOptions = {}): Promise<SubmittedTurn> {
    const prepared = await this.#sessions.prepareUserMessage(content);
    await options.onSessionPrepared?.(prepared.session, prepared.created);
    const signal =
      options.signal === undefined
        ? AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000),
          ]);
    const result = await this.#runtime.run(prepared.state, {
      model: this.#model,
      environment: this.#environment,
      historyObserver: prepared.historyObserver,
      signal,
      modelRequestTimeoutMs: this.#limits.modelRequestTimeoutSeconds * 1_000,
      modelMaxAttempts: this.#limits.modelMaxAttempts,
      ...(options.observers === undefined ? {} : { observers: options.observers }),
      ...(options.onTextDelta === undefined ? {} : { onTextDelta: options.onTextDelta }),
      ...(options.onReasoningDelta === undefined
        ? {}
        : { onReasoningDelta: options.onReasoningDelta }),
      ...(this.#verification === undefined ? {} : { verification: this.#verification }),
    });
    return {
      created: prepared.created,
      session: prepared.session,
      result,
    };
  }

  getContextStatus(): ContextBudget {
    return estimateContextBudget({
      systemPrompt: this.#systemPrompt,
      events: this.#sessions.active?.state.events ?? [],
      tools: this.#environment.tools(),
      contextWindow: this.#modelDescriptor.contextWindow,
      includeImages: this.#modelDescriptor.capabilities.vision,
      includeReasoning: this.#modelDescriptor.capabilities.reasoning.enabled,
    });
  }

  listModels(signal?: AbortSignal): Promise<readonly string[]> {
    return this.#provider.listModels(this.#modelConfiguration, signal);
  }

  async selectModel(id: string): Promise<ModelSelectionResult> {
    if (id === this.#modelDescriptor.modelId) {
      return { descriptor: this.#modelDescriptor, changed: false };
    }
    const configuration = this.#provider.selectModel(this.#modelConfiguration, id);
    await this.#settings.saveModelId(configuration.modelId);
    this.#replaceModel(configuration);
    return { descriptor: this.#modelDescriptor, changed: true };
  }

  async selectThinking(selection: ThinkingSelection): Promise<ModelSelectionResult> {
    const selected = this.#provider.selectReasoning(this.#modelConfiguration, selection);
    const nextDescriptor = this.#provider.describe(selected.configuration);
    const currentReasoning = this.#modelDescriptor.capabilities.reasoning;
    const nextReasoning = nextDescriptor.capabilities.reasoning;
    const changed =
      nextReasoning.enabled !== currentReasoning.enabled ||
      nextReasoning.effort !== currentReasoning.effort;
    await this.#settings.saveModelProviderOptions(
      selected.configuration.providerId,
      selected.settingsUpdate,
    );
    if (changed) this.#replaceModel(selected.configuration);
    return { descriptor: this.#modelDescriptor, changed };
  }

  async compactContext(options: CompactionOptions = {}): Promise<CompactionResult> {
    const active = this.#sessions.active;
    if (!active) return { status: "no-session" };
    const plan = createCompactionPlan(active.state.events);
    if (!plan) return { status: "not-enough-history" };

    const before = this.getContextStatus();
    await options.onStarted?.();
    const effectiveSignal =
      options.signal === undefined
        ? AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000),
          ]);
    const summary = await this.#summarizer.summarize(plan.eventsToSummarize, effectiveSignal);
    const event = {
      type: "compaction" as const,
      summary,
      retainedEvents: plan.retainedEvents,
    };
    const after = estimateContextBudget({
      systemPrompt: this.#systemPrompt,
      events: [...active.state.events, event],
      tools: this.#environment.tools(),
      contextWindow: this.#modelDescriptor.contextWindow,
      includeImages: this.#modelDescriptor.capabilities.vision,
      includeReasoning: this.#modelDescriptor.capabilities.reasoning.enabled,
    });
    if (after.estimatedTokens >= before.estimatedTokens) {
      return { status: "not-smaller", before, after };
    }

    await this.#sessions.appendPersistentEvent(event);
    return {
      status: "compacted",
      before,
      after,
      retainedUserTurns: plan.retainedUserTurns,
    };
  }

  #replaceModel(configuration: ModelConfiguration): void {
    const descriptor = this.#provider.describe(configuration);
    const model = this.#provider.createAgentModel(configuration);
    const summarizer = this.#provider.createContextSummarizer(configuration);
    this.#modelConfiguration = configuration;
    this.#modelDescriptor = descriptor;
    this.#model = model;
    this.#summarizer = summarizer;
  }
}

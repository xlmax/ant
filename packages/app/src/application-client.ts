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
import type { ContextSettings, RuntimeLimits, VerificationSettings } from "./configuration.js";
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
  context: ContextSettings;
  verification?: VerificationSettings;
}

export interface SubmitTurnOptions {
  observers?: readonly AgentObserver[];
  onTextDelta?: TextDeltaHandler;
  onReasoningDelta?: ReasoningDeltaHandler;
  signal?: AbortSignal;
  onSessionPrepared?(session: AgentSession, created: boolean): void | Promise<void>;
  onAutoCompaction?(event: AutoCompactionEvent): void | Promise<void>;
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

export interface ModelDiagnostic {
  readonly firstActivityMs: number;
  readonly durationMs: number;
  readonly toolsEnabled: boolean;
}

export type AutoCompactionEvent =
  | { readonly type: "started"; readonly before: ContextBudget }
  | {
      readonly type: "completed";
      readonly before: ContextBudget;
      readonly after: ContextBudget;
    }
  | {
      readonly type: "skipped";
      readonly before: ContextBudget;
      readonly reason: "not-enough-history" | "not-smaller";
    }
  | { readonly type: "failed"; readonly before: ContextBudget; readonly message: string };

/** Stable use-case surface consumed by presentation adapters. */
export interface AntApplicationApi {
  readonly modelDescriptor: ModelDescriptor;
  readonly activeSession: ActiveSessionInfo | undefined;
  resumeSession(sessionId: string): Promise<ActiveSessionInfo>;
  getLastTurnEvents(): readonly HistoryEvent[] | undefined;
  resetSession(): void;
  deleteAllSessions(): Promise<number>;
  submitTurn(content: string, options?: SubmitTurnOptions): Promise<SubmittedTurn>;
  getContextStatus(): ContextBudget;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  selectModel(id: string): Promise<ModelSelectionResult>;
  selectThinking(selection: ThinkingSelection): Promise<ModelSelectionResult>;
  diagnoseModel(signal?: AbortSignal): Promise<ModelDiagnostic>;
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
  readonly #context: ContextSettings;
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
    this.#context = dependencies.context;
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

  deleteAllSessions(): Promise<number> {
    return this.#sessions.deleteAll();
  }

  async submitTurn(content: string, options: SubmitTurnOptions = {}): Promise<SubmittedTurn> {
    const signal =
      options.signal === undefined
        ? AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000),
          ]);

    if (this.#context.autoCompact && this.#sessions.active) {
      try {
        await this.#autoCompact(content, signal, options.onAutoCompaction);
      } catch (error) {
        if (signal.aborted && !this.#sessions.active) throw error;
      }
      if (signal.aborted) {
        const active = this.#sessions.active;
        if (!active) throw signal.reason;
        return {
          created: false,
          session: active.session,
          result: { status: "cancelled", state: active.state },
        };
      }
    }

    const prepared = await this.#sessions.prepareUserMessage(content);
    await options.onSessionPrepared?.(prepared.session, prepared.created);
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
    return this.#estimateContext(this.#sessions.active?.state.events ?? []);
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

  async diagnoseModel(signal?: AbortSignal): Promise<ModelDiagnostic> {
    const startedAt = Date.now();
    let firstActivityAt: number | undefined;
    const markActivity = (): void => {
      firstActivityAt ??= Date.now();
    };
    const effectiveSignal =
      signal === undefined
        ? AbortSignal.timeout(this.#limits.modelRequestTimeoutSeconds * 1_000)
        : AbortSignal.any([
            signal,
            AbortSignal.timeout(this.#limits.modelRequestTimeoutSeconds * 1_000),
          ]);
    const tools = this.#environment.tools();
    const decision = await this.#model.decide(
      {
        events: [
          {
            type: "user",
            content:
              "Диагностическая проверка соединения. Не вызывай инструменты. Ответь только словом OK.",
          },
        ],
        tools,
      },
      effectiveSignal,
      markActivity,
      markActivity,
      undefined,
      markActivity,
    );
    markActivity();
    if (decision.type !== "finish") {
      throw new Error("Модель вызвала инструмент во время диагностической проверки");
    }
    if (decision.answer.trim() === "") {
      throw new Error("Модель вернула пустой диагностический ответ");
    }
    const finishedAt = Date.now();
    return {
      firstActivityMs: (firstActivityAt ?? finishedAt) - startedAt,
      durationMs: finishedAt - startedAt,
      toolsEnabled: tools.length > 0,
    };
  }

  async compactContext(options: CompactionOptions = {}): Promise<CompactionResult> {
    const active = this.#sessions.active;
    if (!active) return { status: "no-session" };
    if (!createCompactionPlan(active.state.events)) return { status: "not-enough-history" };
    await options.onStarted?.();
    const effectiveSignal =
      options.signal === undefined
        ? AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.#limits.turnTimeoutSeconds * 1_000),
          ]);
    return this.#compactActiveContext(effectiveSignal);
  }

  #estimateContext(events: readonly HistoryEvent[]): ContextBudget {
    const tools = this.#environment.tools();
    return estimateContextBudget({
      systemPrompt: this.#systemPrompt,
      events,
      tools,
      contextWindow: this.#modelDescriptor.contextWindow,
      includeImages: this.#modelDescriptor.capabilities.vision,
      includeReasoning: tools.length > 0,
    });
  }

  async #autoCompact(
    content: string,
    signal: AbortSignal,
    notify?: (event: AutoCompactionEvent) => void | Promise<void>,
  ): Promise<void> {
    const active = this.#sessions.active;
    if (!active) return;
    const pendingUser = { type: "user" as const, content };
    const before = this.#estimateContext([...active.state.events, pendingUser]);
    if (before.percentage < this.#context.autoCompactThreshold * 100) return;

    await notify?.({ type: "started", before });
    let result: CompactionResult;
    try {
      result = await this.#compactActiveContext(signal);
    } catch (error) {
      if (!signal.aborted) {
        await notify?.({
          type: "failed",
          before,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    if (result.status === "not-enough-history" || result.status === "no-session") {
      await notify?.({ type: "skipped", before, reason: "not-enough-history" });
      return;
    }
    if (result.status === "not-smaller") {
      await notify?.({ type: "skipped", before, reason: "not-smaller" });
      return;
    }

    const compacted = this.#sessions.active;
    if (!compacted) return;
    const after = this.#estimateContext([...compacted.state.events, pendingUser]);
    await notify?.({ type: "completed", before, after });
  }

  async #compactActiveContext(signal: AbortSignal): Promise<CompactionResult> {
    const active = this.#sessions.active;
    if (!active) return { status: "no-session" };
    const plan = createCompactionPlan(active.state.events);
    if (!plan) return { status: "not-enough-history" };

    const before = this.#estimateContext(active.state.events);
    signal.throwIfAborted();
    const summary = await this.#summarizer.summarize(plan.eventsToSummarize, signal);
    signal.throwIfAborted();
    const event = {
      type: "compaction" as const,
      summary,
      retainedEvents: plan.retainedEvents,
    };
    const after = this.#estimateContext([...active.state.events, event]);
    if (after.estimatedTokens >= before.estimatedTokens) {
      return { status: "not-smaller", before, after };
    }

    signal.throwIfAborted();
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

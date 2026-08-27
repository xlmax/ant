import type {
  AgentModel,
  AgentObserver,
  AgentResult,
  Environment,
  ReasoningDeltaHandler,
  TextDeltaHandler,
} from "../core/agent.js";
import { estimateContextBudget, type ContextBudget } from "../core/context-budget.js";
import { createCompactionPlan, type ContextSummarizer } from "../core/context-events.js";
import type { AgentRuntime } from "../core/runtime.js";
import type {
  ModelSettings,
  ReasoningEffort,
  RuntimeLimits,
  VerificationSettings,
} from "./configuration.js";
import type { ModelProvider } from "./model-provider.js";
import { SessionController } from "./session-controller.js";
import type { AgentSession, SessionStore } from "./session.js";

export interface ApplicationSettingsCommands {
  saveModelId(id: string): Promise<boolean>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
}

export interface ApplicationClientDependencies {
  runtime: AgentRuntime;
  provider: ModelProvider;
  sessions: SessionStore;
  environment: Environment;
  systemPrompt: string;
  modelSettings: ModelSettings;
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

export type ThinkingSelection = ReasoningEffort | "off";

export interface ModelSelectionResult {
  settings: ModelSettings;
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
  readonly modelSettings: ModelSettings;
  readonly activeSession: ActiveSessionInfo | undefined;
  resumeSession(sessionId: string): Promise<ActiveSessionInfo>;
  resetSession(): void;
  submitTurn(content: string, options?: SubmitTurnOptions): Promise<SubmittedTurn>;
  getContextStatus(): ContextBudget;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  selectModel(id: string): Promise<ModelSelectionResult>;
  selectThinking(selection: ThinkingSelection): Promise<ModelSelectionResult>;
  compactContext(options?: CompactionOptions): Promise<CompactionResult>;
}

function selectedThinking(
  current: ModelSettings["thinking"],
  selection: ThinkingSelection,
): ModelSettings["thinking"] {
  if (selection === "off") return { ...current, enabled: false };
  return { enabled: true, effort: selection };
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
  #modelSettings: ModelSettings;
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
    this.#modelSettings = dependencies.modelSettings;
    this.#model = dependencies.provider.createAgentModel(dependencies.modelSettings);
    this.#summarizer = dependencies.provider.createContextSummarizer(dependencies.modelSettings);
  }

  get modelSettings(): ModelSettings {
    return this.#modelSettings;
  }

  get activeSession(): ActiveSessionInfo | undefined {
    const active = this.#sessions.active;
    return active === undefined ? undefined : { session: active.session };
  }

  async resumeSession(sessionId: string): Promise<ActiveSessionInfo> {
    const active = await this.#sessions.resume(sessionId);
    return { session: active.session };
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
      historyObserver: prepared.session.observer,
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
      contextWindow: this.#modelSettings.contextWindow,
      includeImages: this.#modelSettings.vision,
      includeReasoning: this.#modelSettings.thinking.enabled,
    });
  }

  listModels(signal?: AbortSignal): Promise<readonly string[]> {
    return this.#provider.listModels(this.#modelSettings, signal);
  }

  async selectModel(id: string): Promise<ModelSelectionResult> {
    if (id === this.#modelSettings.id) {
      return { settings: this.#modelSettings, changed: false };
    }
    const vision = await this.#settings.saveModelId(id);
    this.#replaceModel({ ...this.#modelSettings, id, vision });
    return { settings: this.#modelSettings, changed: true };
  }

  async selectThinking(selection: ThinkingSelection): Promise<ModelSelectionResult> {
    const thinking = selectedThinking(this.#modelSettings.thinking, selection);
    const changed =
      thinking.enabled !== this.#modelSettings.thinking.enabled ||
      thinking.effort !== this.#modelSettings.thinking.effort;
    await this.#settings.saveThinking(thinking);
    if (changed) this.#replaceModel({ ...this.#modelSettings, thinking });
    return { settings: this.#modelSettings, changed };
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
      contextWindow: this.#modelSettings.contextWindow,
      includeImages: this.#modelSettings.vision,
      includeReasoning: this.#modelSettings.thinking.enabled,
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

  #replaceModel(settings: ModelSettings): void {
    const model = this.#provider.createAgentModel(settings);
    const summarizer = this.#provider.createContextSummarizer(settings);
    this.#modelSettings = settings;
    this.#model = model;
    this.#summarizer = summarizer;
  }
}

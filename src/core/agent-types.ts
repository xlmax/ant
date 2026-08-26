import type { VerificationSettings } from "./verification.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ToolCalls = [ToolCall, ...ToolCall[]];

export type Decision =
  | { type: "tools"; calls: ToolCalls; reasoning?: string }
  | { type: "finish"; answer: string; reasoning?: string };

export interface ImageAttachment {
  type: "image";
  path: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  bytes: number;
}

export interface Observation {
  ok: boolean;
  value?: unknown;
  attachments?: readonly ImageAttachment[];
  error?: string;
}

export interface ToolOutput {
  stream: "stdout" | "stderr";
  content: string;
}

export type ToolOutputHandler = (call: ToolCall, output: ToolOutput) => void;
export type ToolStartedHandler = (call: ToolCall) => void;
export type SingleToolOutputHandler = (output: ToolOutput) => void;

export type HistoryEvent =
  | { type: "task"; content: string }
  | { type: "user"; content: string }
  | { type: "decision"; decision: Decision }
  | { type: "compaction"; summary: string; retainedEvents: HistoryEvent[] }
  | { type: "observation"; call: ToolCall; observation: Observation }
  | {
      type: "verification";
      feedback: string;
      round: number;
      maxRounds: number;
    };

export type LifecycleEvent =
  | { type: "model.requested"; attempt: number; maxAttempts: number }
  | {
      type: "model.retry";
      reason: string;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
    }
  | { type: "model.usage"; usage: ModelUsage }
  | { type: "tool.started"; call: ToolCall }
  | { type: "tool.output"; call: ToolCall; output: ToolOutput }
  | { type: "tool.finished"; call: ToolCall; observation: Observation; durationMs: number };

export type AgentEvent = HistoryEvent | LifecycleEvent;

export interface AgentState {
  events: HistoryEvent[];
}

export interface ModelInput {
  events: readonly HistoryEvent[];
  tools: readonly ToolSpec[];
}

export interface ModelUsage {
  provider: string;
  model: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
  source: "provider" | "estimated";
}

export type TextDeltaHandler = (text: string) => void;
export type ReasoningDeltaHandler = (text: string) => void;
export type ModelUsageHandler = (usage: ModelUsage) => void;
export type ModelActivityHandler = () => void;

export interface AgentModel {
  decide(
    input: ModelInput,
    signal?: AbortSignal,
    onTextDelta?: TextDeltaHandler,
    onReasoningDelta?: ReasoningDeltaHandler,
    onUsage?: ModelUsageHandler,
    onActivity?: ModelActivityHandler,
  ): Promise<Decision>;
}

export class ModelRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ModelRequestError";
    this.retryable = retryable;
  }
}

export interface Environment {
  tools(): readonly ToolSpec[];
  execute(
    call: ToolCall,
    signal?: AbortSignal,
    onOutput?: SingleToolOutputHandler,
  ): Promise<Observation>;
  executeMany(
    calls: ToolCalls,
    signal?: AbortSignal,
    onOutput?: ToolOutputHandler,
    onStarted?: ToolStartedHandler,
  ): Promise<readonly Observation[]>;
}

export type AgentResult =
  | {
      status: "completed";
      answer: string;
      /**
       * Optional mechanical-check summary (which verification commands ran and
       * whether they passed). Kept separate from `answer` so the UI can render
       * it even when the answer itself was already streamed live.
       */
      verificationSummary?: string;
      state: AgentState;
    }
  | { status: "cancelled"; state: AgentState };

export interface AgentObserver {
  onEvent(event: AgentEvent): void | Promise<void>;
}

export interface AgentDependencies {
  model: AgentModel;
  environment: Environment;
  observers?: readonly AgentObserver[];
  /**
   * The durable history sink (session journal). It is written strictly before
   * the in-memory state is mutated and before UI observers run, so a failure
   * in rendering can never leave the journal ahead of the agent state.
   */
  historyObserver?: AgentObserver;
  onTextDelta?: TextDeltaHandler;
  onReasoningDelta?: ReasoningDeltaHandler;
  signal?: AbortSignal;
  modelRequestTimeoutMs?: number;
  modelMaxAttempts?: number;
  retryDelayMs?: number;
  /**
   * Mechanical self-verification gate that runs before a turn is allowed to
   * complete. When a `finish` decision fails the checks, the feedback is fed
   * back to the model and the turn continues (up to `maxRounds` extra
   * rounds). Omitted or `enabled: false` disables the gate entirely.
   */
  verification?: VerificationSettings;
}

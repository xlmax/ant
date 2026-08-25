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

export type AgentEvent =
  | { type: "task"; content: string }
  | { type: "user"; content: string }
  | { type: "model.requested"; attempt: number; maxAttempts: number }
  | {
      type: "model.retry";
      reason: string;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
    }
  | { type: "model.usage"; usage: ModelUsage }
  | { type: "decision"; decision: Decision }
  | { type: "compaction"; summary: string; retainedEvents: AgentEvent[] }
  | { type: "tool.started"; call: ToolCall }
  | { type: "tool.output"; call: ToolCall; output: ToolOutput }
  | { type: "tool.finished"; call: ToolCall; observation: Observation; durationMs: number }
  | { type: "observation"; call: ToolCall; observation: Observation };

export interface AgentState {
  events: AgentEvent[];
}

export interface ModelInput {
  events: readonly AgentEvent[];
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
  | { status: "completed"; answer: string; state: AgentState }
  | { status: "cancelled"; state: AgentState };

export interface AgentObserver {
  onEvent(event: AgentEvent): void | Promise<void>;
}

export interface AgentDependencies {
  model: AgentModel;
  environment: Environment;
  observers?: readonly AgentObserver[];
  onTextDelta?: TextDeltaHandler;
  onReasoningDelta?: ReasoningDeltaHandler;
  signal?: AbortSignal;
  modelRequestTimeoutMs?: number;
  modelMaxAttempts?: number;
  retryDelayMs?: number;
}

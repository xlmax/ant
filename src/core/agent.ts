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
  | {
      type: "observation";
      call: ToolCall;
      observation: Observation;
    };

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
  compact?(input: ModelInput, signal?: AbortSignal): Promise<string>;
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
  executeMany?(
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

export function createAgentState(task: string): AgentState {
  return {
    events: [{ type: "task", content: task }],
  };
}

async function appendEvent(
  state: AgentState,
  event: AgentEvent,
  observers: readonly AgentObserver[],
): Promise<void> {
  state.events.push(event);

  for (const observer of observers) {
    await observer.onEvent(event);
  }
}

async function notifyEvent(event: AgentEvent, observers: readonly AgentObserver[]): Promise<void> {
  for (const observer of observers) {
    await observer.onEvent(event);
  }
}

function retryReason(error: unknown, requestTimedOut: boolean): string | undefined {
  if (requestTimedOut) {
    return "Модель не передавала данные за отведённое время";
  }

  if (error instanceof ModelRequestError && error.retryable) {
    return error.message;
  }

  return undefined;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createRequestTimeout(
  timeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
): {
  signal: AbortSignal | undefined;
  reset(): void;
  dispose(): void;
  timedOut(): boolean;
} {
  if (timeoutMs === undefined) {
    return {
      signal: parentSignal,
      reset: () => {},
      dispose: () => {},
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reset = (): void => {
    if (handle !== undefined) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => controller.abort(), timeoutMs);
  };

  reset();
  return {
    signal:
      parentSignal === undefined
        ? controller.signal
        : AbortSignal.any([parentSignal, controller.signal]),
    reset,
    dispose: () => {
      if (handle !== undefined) {
        clearTimeout(handle);
      }
    },
    timedOut: () => controller.signal.aborted,
  };
}

export async function runAgent(
  state: AgentState,
  dependencies: AgentDependencies,
): Promise<AgentResult> {
  const {
    model,
    environment,
    observers = [],
    onTextDelta,
    onReasoningDelta,
    signal,
    modelRequestTimeoutMs,
    modelMaxAttempts = 1,
    retryDelayMs = 1_000,
  } = dependencies;

  if (!Number.isInteger(modelMaxAttempts) || modelMaxAttempts <= 0) {
    throw new Error("Количество попыток модели должно быть положительным целым числом");
  }

  while (!signal?.aborted) {
    let decision: Decision | undefined;
    let usage: ModelUsage | undefined;

    for (let attempt = 1; attempt <= modelMaxAttempts; attempt += 1) {
      await appendEvent(
        state,
        { type: "model.requested", attempt, maxAttempts: modelMaxAttempts },
        observers,
      );
      usage = undefined;
      let receivedText = false;
      const request = createRequestTimeout(modelRequestTimeoutMs, signal);

      try {
        decision = await model.decide(
          {
            events: state.events,
            tools: environment.tools(),
          },
          request.signal,
          onTextDelta === undefined
            ? undefined
            : (text) => {
                request.reset();
                receivedText = true;
                onTextDelta(text);
              },
          onReasoningDelta === undefined
            ? undefined
            : (text) => {
                request.reset();
                onReasoningDelta(text);
              },
          (reportedUsage) => {
            usage = reportedUsage;
          },
          () => request.reset(),
        );
        break;
      } catch (error) {
        if (signal?.aborted) {
          return { status: "cancelled", state };
        }

        const reason = retryReason(error, request.timedOut());
        if (reason === undefined) {
          throw error;
        }
        if (receivedText) {
          throw new Error(`${reason}. Текст ответа уже начал выводиться, повтор не выполнен.`, {
            cause: error,
          });
        }
        if (attempt === modelMaxAttempts) {
          throw new Error(`${reason}. Попытки исчерпаны (${attempt}/${modelMaxAttempts}).`, {
            cause: error,
          });
        }

        const delayMs = retryDelayMs * 2 ** (attempt - 1);
        await appendEvent(
          state,
          {
            type: "model.retry",
            reason,
            nextAttempt: attempt + 1,
            maxAttempts: modelMaxAttempts,
            delayMs,
          },
          observers,
        );
        try {
          await waitForRetry(delayMs, signal);
        } catch {
          return { status: "cancelled", state };
        }
      } finally {
        request.dispose();
      }
    }

    if (!decision) {
      throw new Error("Модель не вернула решение");
    }

    if (usage) {
      await appendEvent(state, { type: "model.usage", usage }, observers);
    }

    await appendEvent(state, { type: "decision", decision }, observers);

    switch (decision.type) {
      case "finish":
        return {
          status: "completed",
          answer: decision.answer,
          state,
        };

      case "tools": {
        const startedAt = new Map<string, number>();
        let toolEvents = Promise.resolve();
        const onToolStarted: ToolStartedHandler = (call) => {
          startedAt.set(call.id, Date.now());
          toolEvents = toolEvents.then(() =>
            notifyEvent({ type: "tool.started", call }, observers),
          );
        };
        const onToolOutput: ToolOutputHandler = (call, output) => {
          toolEvents = toolEvents.then(() =>
            notifyEvent({ type: "tool.output", call, output }, observers),
          );
        };
        let observations: readonly Observation[];
        try {
          if (environment.executeMany) {
            observations = await environment.executeMany(
              decision.calls,
              signal,
              onToolOutput,
              onToolStarted,
            );
          } else {
            const sequential: Observation[] = [];
            for (const call of decision.calls) {
              onToolStarted(call);
              sequential.push(
                await environment.execute(call, signal, (output) => onToolOutput(call, output)),
              );
            }
            observations = sequential;
          }
        } catch (error) {
          await toolEvents;
          if (signal?.aborted) {
            for (const call of decision.calls) {
              if (!startedAt.has(call.id)) continue;
              await notifyEvent(
                {
                  type: "tool.finished",
                  call,
                  observation: { ok: false, error: "Tool call was cancelled" },
                  durationMs: Date.now() - (startedAt.get(call.id) ?? Date.now()),
                },
                observers,
              );
            }
            return { status: "cancelled", state };
          }
          throw error;
        }
        await toolEvents;

        for (const [index, call] of decision.calls.entries()) {
          const observation = observations[index];
          if (!observation) {
            throw new Error(`Environment did not return an observation for tool call ${call.id}`);
          }
          await notifyEvent(
            {
              type: "tool.finished",
              call,
              observation,
              durationMs: Date.now() - (startedAt.get(call.id) ?? Date.now()),
            },
            observers,
          );
          await appendEvent(
            state,
            {
              type: "observation",
              call,
              observation,
            },
            observers,
          );
        }
        break;
      }
    }
  }

  return { status: "cancelled", state };
}

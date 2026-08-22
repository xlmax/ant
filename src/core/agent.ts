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
  | { type: "tools"; calls: ToolCalls }
  | { type: "ask"; question: string }
  | { type: "finish"; answer: string };

export interface Observation {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type AgentEvent =
  | { type: "task"; content: string }
  | { type: "user"; content: string }
  | { type: "model.requested" }
  | { type: "decision"; decision: Decision }
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

export type TextDeltaHandler = (text: string) => void;

export interface AgentModel {
  decide(
    input: ModelInput,
    signal?: AbortSignal,
    onTextDelta?: TextDeltaHandler,
  ): Promise<Decision>;
}

export interface Environment {
  tools(): readonly ToolSpec[];
  execute(call: ToolCall, signal?: AbortSignal): Promise<Observation>;
}

export type AgentResult =
  | { status: "completed"; answer: string; state: AgentState }
  | { status: "waiting"; question: string; state: AgentState }
  | { status: "cancelled"; state: AgentState };

export interface AgentObserver {
  onEvent(event: AgentEvent): void | Promise<void>;
}

export interface AgentDependencies {
  model: AgentModel;
  environment: Environment;
  observers?: readonly AgentObserver[];
  onTextDelta?: TextDeltaHandler;
  signal?: AbortSignal;
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

export async function runAgent(
  state: AgentState,
  dependencies: AgentDependencies,
): Promise<AgentResult> {
  const { model, environment, observers = [], onTextDelta, signal } = dependencies;

  while (!signal?.aborted) {
    let decision: Decision;

    await appendEvent(state, { type: "model.requested" }, observers);

    try {
      decision = await model.decide(
        {
          events: state.events,
          tools: environment.tools(),
        },
        signal,
        onTextDelta,
      );
    } catch (error) {
      if (signal?.aborted) {
        return { status: "cancelled", state };
      }

      throw error;
    }

    await appendEvent(state, { type: "decision", decision }, observers);

    switch (decision.type) {
      case "finish":
        return {
          status: "completed",
          answer: decision.answer,
          state,
        };

      case "ask":
        return {
          status: "waiting",
          question: decision.question,
          state,
        };

      case "tools":
        for (const call of decision.calls) {
          let observation: Observation;

          try {
            observation = await environment.execute(call, signal);
          } catch (error) {
            if (signal?.aborted) {
              return { status: "cancelled", state };
            }

            throw error;
          }

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

  return { status: "cancelled", state };
}

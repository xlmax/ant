import { formatVerificationSummary, isMutatingBashCommand, verifyTurn } from "./verification.js";

import {
  ModelRequestError,
  type AgentDependencies,
  type AgentEvent,
  type AgentObserver,
  type AgentResult,
  type AgentState,
  type Decision,
  type Environment,
  type HistoryEvent,
  type ModelUsage,
  type Observation,
  type ToolCall,
  type ToolCalls,
  type ToolOutputHandler,
  type ToolStartedHandler,
} from "./agent-types.js";

export function createAgentState(task: string): AgentState {
  return { events: [{ type: "task", content: task }] };
}

async function appendHistoryEvent(
  state: AgentState,
  event: HistoryEvent,
  historyObserver: AgentObserver | undefined,
  observers: readonly AgentObserver[],
): Promise<void> {
  // Strict ordering: 1) persist to the durable journal, 2) mutate in-memory
  // state, 3) notify UI observers. A failure in any step leaves the journal
  // and the state consistent with each other — only rendering is skipped.
  if (historyObserver) await historyObserver.onEvent(event);
  state.events.push(event);
  for (const observer of observers) await observer.onEvent(event);
}

async function notifyEvent(event: AgentEvent, observers: readonly AgentObserver[]): Promise<void> {
  for (const observer of observers) await observer.onEvent(event);
}

function commandObservationPassed(observation: Observation): boolean {
  if (!observation.ok) return false;
  const value = observation.value as { exitCode?: number } | undefined;
  return value?.exitCode === 0;
}

/**
 * Runs the configured verification commands through the `bash` tool, appends
 * every result to the journal and in-memory history, and reports whether all
 * of them passed. This is the mechanical part of the gate: the commands
 * really run and their output is persisted, so the model cannot claim a
 * check passed on its word alone.
 */
async function runVerificationCommands(
  commands: readonly string[],
  round: number,
  state: AgentState,
  environment: Environment,
  signal: AbortSignal | undefined,
  historyObserver: AgentObserver | undefined,
  observers: readonly AgentObserver[],
): Promise<{ passed: boolean; feedback: string }> {
  const calls = commands.map((command, index): ToolCall => ({
    id: `verify-cmd-${round}-${index}`,
    name: "bash",
    input: { command },
  }));

  let toolEvents = Promise.resolve();
  const onStarted: ToolStartedHandler = (call) => {
    toolEvents = toolEvents.then(() => notifyEvent({ type: "tool.started", call }, observers));
  };
  const onOutput: ToolOutputHandler = (call, output) => {
    toolEvents = toolEvents.then(() =>
      notifyEvent({ type: "tool.output", call, output }, observers),
    );
  };

  const startedAt = Date.now();
  let observations: readonly Observation[];
  try {
    observations = await environment.executeMany(calls as ToolCalls, signal, onOutput, onStarted);
  } catch (error) {
    await toolEvents;
    return {
      passed: false,
      feedback: `Команды проверки не запустились: ${String(error)}\nИсправь проблему и заверши ход заново.`,
    };
  }
  await toolEvents;

  const failed: string[] = [];
  for (const [index, call] of calls.entries()) {
    const observation = observations[index];
    if (!observation) {
      throw new Error(`Environment did not return an observation for tool call ${call.id}`);
    }
    await appendHistoryEvent(
      state,
      { type: "observation", call, observation },
      historyObserver,
      observers,
    );
    await notifyEvent(
      { type: "tool.finished", call, observation, durationMs: Date.now() - startedAt },
      observers,
    );

    if (!commandObservationPassed(observation)) {
      const value = observation.value as { exitCode?: number; output?: unknown } | undefined;
      const output = observation.ok ? String(value?.output ?? "") : (observation.error ?? "");
      failed.push(
        `- \`${commands[index]}\` (exit ${value?.exitCode ?? "?"}): ${output === "" ? "нет вывода" : output.slice(0, 300)}`,
      );
    }
  }

  if (failed.length === 0) {
    return { passed: true, feedback: "" };
  }

  return {
    passed: false,
    feedback: `Команды проверки не прошли:\n${failed.join("\n")}\nИсправь ошибки и заверши ход заново.`,
  };
}

function retryReason(error: unknown, requestTimedOut: boolean): string | undefined {
  if (requestTimedOut) return "Модель не передавала данные за отведённое время";
  if (error instanceof ModelRequestError && error.retryable) return error.message;
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
    return { signal: parentSignal, reset: () => {}, dispose: () => {}, timedOut: () => false };
  }

  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const reset = (): void => {
    if (handle !== undefined) clearTimeout(handle);
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
      if (handle !== undefined) clearTimeout(handle);
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
    historyObserver,
    onTextDelta,
    onReasoningDelta,
    signal,
    modelRequestTimeoutMs,
    modelMaxAttempts = 1,
    retryDelayMs = 1_000,
    verification,
  } = dependencies;

  if (!Number.isInteger(modelMaxAttempts) || modelMaxAttempts <= 0) {
    throw new Error("Количество попыток модели должно быть положительным целым числом");
  }

  // Everything already present in the state when the turn starts belongs to
  // earlier turns, so the verification gate only inspects events added below.
  const turnStartIndex = state.events.length;
  let verificationRound = 0;
  let madeChanges = false;
  const gate = verification?.enabled === true ? verification : undefined;

  while (!signal?.aborted) {
    let decision: Decision | undefined;
    let usage: ModelUsage | undefined;

    for (let attempt = 1; attempt <= modelMaxAttempts; attempt += 1) {
      await notifyEvent(
        { type: "model.requested", attempt, maxAttempts: modelMaxAttempts },
        observers,
      );
      usage = undefined;
      let receivedText = false;
      const request = createRequestTimeout(modelRequestTimeoutMs, signal);

      try {
        decision = await model.decide(
          { events: state.events, tools: environment.tools() },
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
        if (signal?.aborted) return { status: "cancelled", state };
        const reason = retryReason(error, request.timedOut());
        if (reason === undefined) throw error;
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
        await notifyEvent(
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

    if (!decision) throw new Error("Модель не вернула решение");
    if (usage) await notifyEvent({ type: "model.usage", usage }, observers);
    await appendHistoryEvent(state, { type: "decision", decision }, historyObserver, observers);

    if (decision.type === "finish") {
      let verificationSummary = "";
      if (gate) {
        const outcome = verifyTurn(
          { answer: decision.answer, events: state.events, turnStartIndex },
          gate,
        );
        if (!outcome.ok && verificationRound < gate.maxRounds) {
          verificationRound += 1;
          await appendHistoryEvent(
            state,
            {
              type: "verification",
              feedback: outcome.feedback,
              round: verificationRound,
              maxRounds: gate.maxRounds,
            },
            historyObserver,
            observers,
          );
          continue;
        }

        // Mechanical command gate: when the turn changed files and commands
        // are configured, actually run them before allowing the turn to
        // finish. Failing output is fed back to the model to fix.
        if (gate.commands.length > 0 && madeChanges) {
          if (verificationRound < gate.maxRounds) {
            const { passed, feedback } = await runVerificationCommands(
              gate.commands,
              verificationRound,
              state,
              environment,
              signal,
              historyObserver,
              observers,
            );
            if (!passed) {
              verificationRound += 1;
              await appendHistoryEvent(
                state,
                {
                  type: "verification",
                  feedback,
                  round: verificationRound,
                  maxRounds: gate.maxRounds,
                },
                historyObserver,
                observers,
              );
              continue;
            }
            verificationSummary = formatVerificationSummary(gate.commands, true);
          } else {
            // Attempts exhausted: finish anyway, but report the failure so the
            // user can see the checks did not pass.
            verificationSummary = formatVerificationSummary(gate.commands, false);
          }
        }
      }
      const answer = decision.answer;
      return {
        status: "completed",
        answer,
        state,
        ...(verificationSummary === "" ? {} : { verificationSummary }),
      };
    }

    for (const call of decision.calls) {
      if (call.name === "edit" || call.name === "write") {
        madeChanges = true;
      } else if (call.name === "bash") {
        const command = (call.input as { command?: string } | undefined)?.command ?? "";
        if (isMutatingBashCommand(command)) madeChanges = true;
      }
    }

    const startedAt = new Map<string, number>();
    let toolEvents = Promise.resolve();
    const onToolStarted: ToolStartedHandler = (call) => {
      startedAt.set(call.id, Date.now());
      toolEvents = toolEvents.then(() => notifyEvent({ type: "tool.started", call }, observers));
    };
    const onToolOutput: ToolOutputHandler = (call, output) => {
      toolEvents = toolEvents.then(() =>
        notifyEvent({ type: "tool.output", call, output }, observers),
      );
    };
    let observations: readonly Observation[];
    try {
      observations = await environment.executeMany(
        decision.calls,
        signal,
        onToolOutput,
        onToolStarted,
      );
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
      if (!observation)
        throw new Error(`Environment did not return an observation for tool call ${call.id}`);
      await notifyEvent(
        {
          type: "tool.finished",
          call,
          observation,
          durationMs: Date.now() - (startedAt.get(call.id) ?? Date.now()),
        },
        observers,
      );
      await appendHistoryEvent(
        state,
        { type: "observation", call, observation },
        historyObserver,
        observers,
      );
    }
  }

  return { status: "cancelled", state };
}

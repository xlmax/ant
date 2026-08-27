import type { HistoryEvent } from "./agent.js";

/**
 * A mechanical (deterministic, non-LLM) self-verification gate that runs
 * before the agent is allowed to finish a turn. Each check inspects the turn
 * history and the proposed final answer without making a model call. If any
 * check fails, the gate produces a feedback message that is fed back to the
 * model so it can correct the answer (or keep working) and finish again.
 */
export type VerificationCheck = "empty-answer" | "echo-task" | "failed-tools";

export interface VerificationSettings {
  enabled: boolean;
  maxRounds: number;
  checks: readonly VerificationCheck[];
}

export interface VerificationIssue {
  code: VerificationCheck;
  message: string;
}

export interface VerificationOutcome {
  ok: boolean;
  issues: readonly VerificationIssue[];
  /** Human-readable feedback to feed back to the model when the gate fails. */
  feedback: string;
}

export interface VerificationInput {
  /** The final answer the model proposed. */
  answer: string;
  /** Full session history. */
  events: readonly HistoryEvent[];
  /** Events at or after this index belong to the current turn. */
  turnStartIndex: number;
}

const FEEDBACK_INTRO = "Механическая самопроверка перед завершением хода выявила проблемы:";

/**
 * Extracts a short failure signature from an error message: an error code
 * (`ENOENT`, `EACCES`) or an error type (`TypeError`, `ReferenceError`).
 * Used instead of the full message so the answer only needs to name the
 * error, not quote the whole text (which often includes a path).
 */
function errorSignature(error: string): string | undefined {
  const code = error.match(/^[A-Z][A-Z0-9_]{1,20}(?=:)/u);
  if (code) return code[0];
  const type = error.match(/([A-Z][A-Za-z]+Error)(?=:)/u);
  return type?.[0];
}

/** Words that acknowledge a failure even when the exact error text is not quoted. */
const FAILURE_WORDS = [
  "ошибк",
  "не удалось",
  "не найден",
  "недоступн",
  "отказ",
  "fail",
  "error",
  "not found",
];

function acknowledgesError(answer: string, error: string): boolean {
  const lower = answer.toLowerCase();
  const signature = errorSignature(error);
  if (signature !== undefined && lower.includes(signature.toLowerCase())) {
    return true;
  }
  // No error code in the answer — accept a generic failure acknowledgment.
  return FAILURE_WORDS.some((word) => lower.includes(word));
}

function lastTaskContent(events: readonly HistoryEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) break;
    if (event.type === "task" || event.type === "user") {
      return event.content;
    }
  }
  return undefined;
}

export function verifyTurn(
  input: VerificationInput,
  settings: VerificationSettings,
): VerificationOutcome {
  const issues: VerificationIssue[] = [];
  const enabled = new Set(settings.checks);
  const answer = input.answer.trim();

  // 1. The agent must not "finish" with a blank answer.
  if (enabled.has("empty-answer") && answer === "") {
    issues.push({
      code: "empty-answer",
      message: "Ход завершён пустым ответом — сформулируй итоговый ответ для пользователя.",
    });
  }

  // 2. An answer that only repeats the task verbatim means no work was done.
  if (enabled.has("echo-task")) {
    const task = lastTaskContent(input.events);
    if (task !== undefined && task.trim() !== "" && answer === task.trim()) {
      issues.push({
        code: "echo-task",
        message:
          "Ответ просто повторяет постановку задачи без её выполнения — выполни работу и дай содержательный ответ.",
      });
    }
  }

  // 3. Tool errors from this turn must be acknowledged in the final answer.
  if (enabled.has("failed-tools")) {
    const failures = new Map<string, string>();
    for (const event of input.events.slice(input.turnStartIndex)) {
      if (event.type !== "observation" || event.observation.ok) continue;
      const error = event.observation.error ?? "";
      const name = event.call.name;
      if (!failures.has(name)) failures.set(name, error);
    }

    const unaddressed = [...failures.entries()].filter(([, error]) => {
      if (error === "") return true; // no error text -> cannot be acknowledged
      return !acknowledgesError(answer, error);
    });

    if (unaddressed.length > 0) {
      const names = [...new Set(unaddressed.map(([name]) => name))].join(", ");
      issues.push({
        code: "failed-tools",
        message:
          `Инструменты в этом ходе вернули ошибку (${names}), но она не отражена в ответе — ` +
          "объясни, что пошло не так, или исправь работу.",
      });
    }
  }

  const ok = issues.length === 0;
  const feedback = ok
    ? ""
    : `${FEEDBACK_INTRO}\n${issues
        .map((issue) => `- ${issue.message}`)
        .join("\n")}\nИсправь ответ (продолжи работу при необходимости) и заверши ход заново.`;

  return { ok, issues, feedback };
}

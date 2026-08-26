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
  /**
   * Shell commands (run through the `bash` tool) that must all exit 0 before
   * a turn that changed files is allowed to finish. This is the mechanical
   * part of the gate: the checks really run, the model cannot claim they
   * passed on its word. Empty array disables command verification.
   */
  commands: readonly string[];
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

/**
 * Heuristic for whether a bash command mutates the workspace, so the command
 * gate fires even when the model edits files through the shell instead of the
 * `edit`/`write` tools (e.g. `echo x >> file`, `sed -i`, `rm`). Read-only
 * commands (`ls`, `git log`, `npm test`) must not match.
 */
export function isMutatingBashCommand(command: string): boolean {
  return /(>>|>|sed\s+-i|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\brmdir\b|\bchmod\b|\bchown\b|\binstall\b|\bdel\b|\bren\b)/u.test(
    command,
  );
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

/**
 * Renders the mechanical-check summary shown after the final answer, so the
 * user sees which commands were actually run (and whether they passed) before
 * the turn completed. Returns an empty string when there is nothing to report.
 */
export function formatVerificationSummary(commands: readonly string[], passed: boolean): string {
  if (commands.length === 0) {
    return "";
  }

  const checks = commands.map((command) => `\`${command}\` ${passed ? "✓" : "✗"}`).join(" · ");
  const headline = passed
    ? "Проверки перед завершением хода:"
    : "Проверки перед завершением хода не пройдены (лимит попыток исчерпан):";
  return `${headline} ${checks}`;
}

/**
 * Returns a stable identifier describing the last tooling that reported a
 * problem in the current turn, used purely for diagnostics and bookkeeping.
 */
export function lastFailureSource(input: VerificationInput): string | undefined {
  const failures = new Map<string, string>();
  for (const event of input.events.slice(input.turnStartIndex)) {
    if (event.type === "observation" && !event.observation.ok) {
      failures.set(event.call.name, event.observation.error ?? "");
    }
  }
  const source = [...failures.entries()].reduce<string | undefined>(
    (acc, [name, error]) =>
      acc ?? `${name}${error ? `: ${errorSignature(error) ?? "unknown"}` : ""}`,
    undefined,
  );
  return source;
}

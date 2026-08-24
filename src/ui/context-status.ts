import type { ContextBudget } from "../core/context-budget.js";
import { ansi } from "./ansi.js";

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatPercentage(percentage: number): string {
  return `${percentage.toFixed(1)}%`;
}

export function formatContextStatus(budget: ContextBudget): string {
  const headline = `Контекст: ~${formatTokens(budget.estimatedTokens)} / ${formatTokens(budget.contextWindow)} (${formatPercentage(budget.percentage)})`;
  const styledHeadline =
    budget.percentage >= 100
      ? ansi.red(headline)
      : budget.percentage >= 80
        ? ansi.yellow(headline)
        : ansi.bold(headline);
  const lines = [
    styledHeadline,
    `  system prompt: ~${formatTokens(budget.breakdown.systemPrompt)}`,
    `  сообщения:     ~${formatTokens(budget.breakdown.messages)}`,
    `  tool results:  ~${formatTokens(budget.breakdown.toolResults)}`,
    `  tool schemas:  ~${formatTokens(budget.breakdown.toolSchemas)}`,
    `  изображения:   ~${formatTokens(budget.breakdown.images)}`,
  ];

  if (budget.heavyObservations.length > 0) {
    lines.push("Крупнейшие результаты инструментов:");
    for (const observation of budget.heavyObservations) {
      lines.push(
        `  ${observation.tool} (${observation.callId}): ~${formatTokens(observation.estimatedTokens)}`,
      );
    }
  }

  if (budget.percentage >= 100) {
    lines.push(ansi.red("Оценка превышает настроенное окно контекста."));
  } else if (budget.percentage >= 80) {
    lines.push(ansi.yellow("Контекст приближается к настроенному лимиту."));
  }
  lines.push(ansi.dim("Оценка приблизительная: 1 токен ≈ 4 байта сериализованного текста."));
  return lines.join("\n");
}

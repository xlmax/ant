import type { HistoryEvent } from "./agent.js";

export interface ContextSummarizer {
  summarize(events: readonly HistoryEvent[], signal?: AbortSignal): Promise<string>;
}

export function activeContextEvents(events: readonly HistoryEvent[]): HistoryEvent[] {
  const compactionIndex = events.findLastIndex((event) => event.type === "compaction");
  if (compactionIndex === -1) return [...events];

  const compaction = events[compactionIndex];
  if (!compaction || compaction.type !== "compaction") return [...events];
  return [compaction, ...compaction.retainedEvents, ...events.slice(compactionIndex + 1)];
}

export interface CompactionPlan {
  eventsToSummarize: HistoryEvent[];
  retainedEvents: HistoryEvent[];
  retainedUserTurns: number;
}

export function createCompactionPlan(
  events: readonly HistoryEvent[],
  retainedUserTurns = 2,
): CompactionPlan | undefined {
  if (!Number.isInteger(retainedUserTurns) || retainedUserTurns <= 0) {
    throw new Error("retainedUserTurns must be a positive integer");
  }

  const active = activeContextEvents(events);
  const userEventIndexes = active.flatMap((event, index) =>
    event.type === "task" || event.type === "user" ? [index] : [],
  );
  if (userEventIndexes.length <= retainedUserTurns) return undefined;

  const retainFrom = userEventIndexes.at(-retainedUserTurns);
  if (retainFrom === undefined || retainFrom <= 0) return undefined;
  const prefix = active.slice(0, retainFrom);
  const eventsToSummarize = prefix.map((event): HistoryEvent =>
    event.type === "compaction"
      ? {
          type: "task",
          content: `Резюме предыдущей части сессии:\n${event.summary}`,
        }
      : event,
  );

  return {
    eventsToSummarize,
    retainedEvents: active.slice(retainFrom).filter((event) => event.type !== "compaction"),
    retainedUserTurns,
  };
}

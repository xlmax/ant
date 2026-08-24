import type { AgentEvent } from "./agent.js";

export interface ContextSummarizer {
  summarize(events: readonly AgentEvent[], signal?: AbortSignal): Promise<string>;
}

function isContextHistoryEvent(event: AgentEvent): boolean {
  return (
    event.type === "task" ||
    event.type === "user" ||
    event.type === "decision" ||
    event.type === "observation" ||
    event.type === "compaction"
  );
}

export function activeContextEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const history = events.filter(isContextHistoryEvent);
  const compactionIndex = history.findLastIndex((event) => event.type === "compaction");
  if (compactionIndex === -1) return history;

  const compaction = history[compactionIndex];
  if (!compaction || compaction.type !== "compaction") return history;
  return [
    compaction,
    ...compaction.retainedEvents.filter(isContextHistoryEvent),
    ...history.slice(compactionIndex + 1),
  ];
}

export interface CompactionPlan {
  eventsToSummarize: AgentEvent[];
  retainedEvents: AgentEvent[];
  retainedUserTurns: number;
}

export function createCompactionPlan(
  events: readonly AgentEvent[],
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
  const eventsToSummarize = prefix.map((event): AgentEvent =>
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

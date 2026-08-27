import type { AgentEvent, HistoryEvent } from "@ant/core";

interface HistoryPayloadV1 {
  schemaVersion: 1;
  kind: "history-event";
  event: HistoryEvent;
}

export function isPersistedEvent(event: AgentEvent): event is HistoryEvent {
  return (
    event.type === "task" ||
    event.type === "user" ||
    event.type === "decision" ||
    event.type === "compaction" ||
    event.type === "observation" ||
    event.type === "verification"
  );
}

export function encodeHistoryEvent(event: AgentEvent): HistoryPayloadV1 | undefined {
  return isPersistedEvent(event)
    ? { schemaVersion: 1, kind: "history-event", event: structuredClone(event) }
    : undefined;
}

export function decodeHistoryEvent(payload: unknown): HistoryEvent {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("schemaVersion" in payload) ||
    !("kind" in payload) ||
    !("event" in payload) ||
    payload.schemaVersion !== 1 ||
    payload.kind !== "history-event" ||
    typeof payload.event !== "object" ||
    payload.event === null ||
    !("type" in payload.event) ||
    !isPersistedEvent(payload.event as AgentEvent)
  ) {
    const version =
      typeof payload === "object" && payload !== null && "schemaVersion" in payload
        ? String(payload.schemaVersion)
        : "missing";
    throw new Error(`Unsupported session payload version or shape: ${version}`);
  }
  return structuredClone(payload.event as HistoryEvent);
}

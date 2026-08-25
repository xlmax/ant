import type {
  Decision,
  ModelActivityHandler,
  ModelUsageHandler,
  ReasoningDeltaHandler,
  TextDeltaHandler,
} from "../../core/agent.js";
import {
  isRecordValue,
  parseDecision,
  parseUsage,
  type ModelMetadata as Metadata,
} from "./protocol.js";

export async function parseStreamingDecision(
  response: Response,
  onTextDelta: TextDeltaHandler,
  onReasoningDelta: ReasoningDeltaHandler | undefined,
  onUsage: ModelUsageHandler | undefined,
  onActivity: ModelActivityHandler | undefined,
  metadata: Metadata,
): Promise<Decision> {
  if (!response.body) throw new Error("DeepSeek returned an empty streaming response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  let content = "";
  let reasoning = "";
  let buffer = "";

  const processEvent = (event: string): void => {
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;

      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("DeepSeek returned invalid streaming JSON");
      }

      const usage = parseUsage(payload, metadata);
      onActivity?.();
      if (usage) onUsage?.(usage);
      if (!isRecordValue(payload) || !Array.isArray(payload.choices)) continue;

      const choice = payload.choices[0];
      if (!isRecordValue(choice) || !isRecordValue(choice.delta)) continue;

      const deltaReasoning = choice.delta.reasoning_content;
      if (typeof deltaReasoning === "string") {
        reasoning += deltaReasoning;
        onReasoningDelta?.(deltaReasoning);
      }

      const deltaContent = choice.delta.content;
      if (typeof deltaContent === "string") {
        content += deltaContent;
        onTextDelta(deltaContent);
      }

      if (!Array.isArray(choice.delta.tool_calls)) continue;
      for (const partialCall of choice.delta.tool_calls) {
        if (!isRecordValue(partialCall)) continue;
        const index =
          typeof partialCall.index === "number" && partialCall.index >= 0 ? partialCall.index : 0;
        const current = toolCalls[index] ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (typeof partialCall.id === "string") current.id = partialCall.id;
        if (isRecordValue(partialCall.function)) {
          if (typeof partialCall.function.name === "string") {
            current.function.name += partialCall.function.name;
          }
          if (typeof partialCall.function.arguments === "string") {
            current.function.arguments += partialCall.function.arguments;
          }
        }
        toolCalls[index] = current;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      processEvent(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) processEvent(buffer);

  const message: Record<string, unknown> = { content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return parseDecision({ choices: [{ message }] });
}

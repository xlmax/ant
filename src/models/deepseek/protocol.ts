import type {
  Decision,
  ImageAttachment,
  ModelUsage,
  Observation,
  ToolCall,
  ToolSpec,
} from "../../core/agent.js";

export interface ModelMetadata {
  provider: string;
  model: string;
  reasoning: string;
  contextWindow: number;
}

export interface DeepSeekFunctionCall {
  name: string;
  arguments: string;
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: DeepSeekFunctionCall;
}

export type DeepSeekContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type DeepSeekMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | DeepSeekContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

export function observationContent(observation: Observation): string {
  return stringify(observation);
}

export function decisionMessage(decision: Decision, includeReasoning: boolean): DeepSeekMessage {
  const reasoning =
    !includeReasoning || decision.reasoning === undefined
      ? {}
      : { reasoning_content: decision.reasoning };

  switch (decision.type) {
    case "tools":
      return {
        role: "assistant",
        content: null,
        ...reasoning,
        tool_calls: decision.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: stringify(call.input),
          },
        })),
      };

    case "finish":
      return { role: "assistant", content: decision.answer, ...reasoning };
  }
}

export function createTools(tools: readonly ToolSpec[]): DeepSeekTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function parseToolCall(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("DeepSeek returned an invalid tool call");
  }

  const functionCall = value.function;
  if (
    !isRecord(functionCall) ||
    typeof functionCall.name !== "string" ||
    typeof functionCall.arguments !== "string"
  ) {
    throw new Error("DeepSeek returned an invalid function call");
  }

  let input: unknown;
  try {
    input = JSON.parse(functionCall.arguments);
  } catch {
    input = functionCall.arguments;
  }

  return { id: value.id, name: functionCall.name, input };
}

export function parseUsage(payload: unknown, metadata: ModelMetadata): ModelUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;

  const inputTokens = payload.usage.prompt_tokens;
  const outputTokens = payload.usage.completion_tokens;
  const totalTokens = payload.usage.total_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }

  return {
    provider: metadata.provider,
    model: metadata.model,
    reasoning: metadata.reasoning,
    inputTokens,
    outputTokens,
    totalTokens,
    contextWindow: metadata.contextWindow,
    source: "provider",
  };
}

export function parseModelList(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("DeepSeek returned an invalid model list");
  }

  return payload.data
    .filter(isRecord)
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .sort((left, right) => left.localeCompare(right));
}

export function parseDecision(payload: unknown): Decision {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("DeepSeek returned an invalid response");
  }

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("DeepSeek response does not contain a message");
  }

  const toolCalls = firstChoice.message.tool_calls;
  const reasoning =
    typeof firstChoice.message.reasoning_content === "string"
      ? firstChoice.message.reasoning_content
      : undefined;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const [firstToolCall, ...remainingToolCalls] = toolCalls;
    return {
      type: "tools",
      calls: [parseToolCall(firstToolCall), ...remainingToolCalls.map(parseToolCall)],
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(
      `DeepSeek response contains neither a tool call nor text: ${JSON.stringify(firstChoice).slice(0, 500)}`,
    );
  }

  return {
    type: "finish",
    answer: content,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

export function imageAttachmentBytes(attachments: readonly ImageAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.bytes, 0);
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

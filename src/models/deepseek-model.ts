import type {
  AgentEvent,
  AgentModel,
  Decision,
  ModelInput,
  ModelUsage,
  ModelUsageHandler,
  Observation,
  ReasoningDeltaHandler,
  ToolCall,
  ToolSpec,
  TextDeltaHandler,
} from "../core/agent.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

interface DeepSeekModelOptions {
  apiKey: string;
  systemPrompt: string;
  model?: string;
  contextWindow?: number;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

interface DeepSeekFunctionCall {
  name: string;
  arguments: string;
}

interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: DeepSeekFunctionCall;
}

type DeepSeekMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface ModelMetadata {
  provider: string;
  model: string;
  reasoning: string;
  contextWindow: number;
}

interface DeepSeekTool {
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

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function observationContent(observation: Observation): string {
  return stringify(observation);
}

function decisionMessage(decision: Decision): DeepSeekMessage {
  const reasoning =
    decision.reasoning === undefined
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

    case "ask":
      return { role: "assistant", content: decision.question, ...reasoning };

    case "finish":
      return { role: "assistant", content: decision.answer, ...reasoning };
  }
}

function eventMessages(event: AgentEvent): DeepSeekMessage[] {
  switch (event.type) {
    case "task":
    case "user":
      return [{ role: "user", content: event.content }];

    case "model.requested":
    case "model.usage":
      return [];

    case "decision":
      return [decisionMessage(event.decision)];

    case "observation":
      return [
        {
          role: "tool",
          tool_call_id: event.call.id,
          content: observationContent(event.observation),
        },
      ];
  }
}

function createMessages(
  events: readonly AgentEvent[],
  systemPrompt: string,
): DeepSeekMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...events.flatMap(eventMessages),
  ];
}

function createTools(tools: readonly ToolSpec[]): DeepSeekTool[] {
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

  return {
    id: value.id,
    name: functionCall.name,
    input,
  };
}

function parseUsage(
  payload: unknown,
  metadata: ModelMetadata,
): ModelUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return undefined;
  }

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

function parseDecision(payload: unknown): Decision {
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
      calls: [
        parseToolCall(firstToolCall),
        ...remainingToolCalls.map(parseToolCall),
      ],
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  const content = firstChoice.message.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(
      `DeepSeek response contains neither a tool call nor text: ${JSON.stringify(
        firstChoice,
      ).slice(0, 500)}`,
    );
  }

  return {
    type: "finish",
    answer: content,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

async function parseStreamingDecision(
  response: Response,
  onTextDelta: TextDeltaHandler,
  onReasoningDelta: ReasoningDeltaHandler | undefined,
  onUsage: ModelUsageHandler | undefined,
  metadata: ModelMetadata,
): Promise<Decision> {
  if (!response.body) {
    throw new Error("DeepSeek returned an empty streaming response");
  }

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

      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice("data:".length).trim();

      if (!data || data === "[DONE]") {
        continue;
      }

      let payload: unknown;

      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("DeepSeek returned invalid streaming JSON");
      }

      const usage = parseUsage(payload, metadata);
      if (usage) {
        onUsage?.(usage);
      }

      if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        continue;
      }

      const choice = payload.choices[0];

      if (!isRecord(choice) || !isRecord(choice.delta)) {
        continue;
      }

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

      if (!Array.isArray(choice.delta.tool_calls)) {
        continue;
      }

      for (const partialCall of choice.delta.tool_calls) {
        if (!isRecord(partialCall)) {
          continue;
        }

        const index =
          typeof partialCall.index === "number" && partialCall.index >= 0
            ? partialCall.index
            : 0;
        const current = toolCalls[index] ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };

        if (typeof partialCall.id === "string") {
          current.id = partialCall.id;
        }

        if (isRecord(partialCall.function)) {
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

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    processEvent(buffer);
  }

  const message: Record<string, unknown> = { content };

  if (reasoning) {
    message.reasoning_content = reasoning;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return parseDecision({ choices: [{ message }] });
}

export class DeepSeekModel implements AgentModel {
  readonly #apiKey: string;
  readonly #systemPrompt: string;
  readonly #model: string;
  readonly #contextWindow: number;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("DeepSeek API key must not be empty");
    }

    if (options.systemPrompt.trim() === "") {
      throw new Error("System prompt must not be empty");
    }

    if ((options.contextWindow ?? DEFAULT_CONTEXT_WINDOW) <= 0) {
      throw new Error("Context window must be greater than zero");
    }

    this.#apiKey = options.apiKey;
    this.#systemPrompt = options.systemPrompt;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(
    input: ModelInput,
    signal?: AbortSignal,
    onTextDelta?: TextDeltaHandler,
    onReasoningDelta?: ReasoningDeltaHandler,
    onUsage?: ModelUsageHandler,
  ): Promise<Decision> {
    const tools = createTools(input.tools);
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: createMessages(input.events, this.#systemPrompt),
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: onTextDelta !== undefined,
    };

    if (onTextDelta) {
      body.stream_options = { include_usage: true };
    }

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    };

    if (signal) {
      request.signal = signal;
    }

    const response = await this.#fetch(
      `${this.#baseUrl}/chat/completions`,
      request,
    );
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `DeepSeek API returned ${response.status}: ${responseText.slice(0, 500)}`,
      );
    }

    if (onTextDelta) {
      return parseStreamingDecision(
        response,
        onTextDelta,
        onReasoningDelta,
        onUsage,
        {
          provider: "deepseek",
          model: this.#model,
          reasoning: "high",
          contextWindow: this.#contextWindow,
        },
      );
    }

    const responseText = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("DeepSeek returned invalid JSON");
    }

    const usage = parseUsage(payload, {
      provider: "deepseek",
      model: this.#model,
      reasoning: "high",
      contextWindow: this.#contextWindow,
    });
    if (usage) {
      onUsage?.(usage);
    }

    return parseDecision(payload);
  }
}

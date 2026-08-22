import type {
  AgentEvent,
  AgentModel,
  Decision,
  ModelInput,
  Observation,
  ToolCall,
  ToolSpec,
  TextDeltaHandler,
} from "../core/agent.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

interface DeepSeekModelOptions {
  apiKey: string;
  systemPrompt: string;
  model?: string;
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
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

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
  switch (decision.type) {
    case "tools":
      return {
        role: "assistant",
        content: null,
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
      return { role: "assistant", content: decision.question };

    case "finish":
      return { role: "assistant", content: decision.answer };
  }
}

function eventMessages(event: AgentEvent): DeepSeekMessage[] {
  switch (event.type) {
    case "task":
    case "user":
      return [{ role: "user", content: event.content }];

    case "model.requested":
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

function parseDecision(payload: unknown): Decision {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("DeepSeek returned an invalid response");
  }

  const firstChoice = payload.choices[0];

  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("DeepSeek response does not contain a message");
  }

  const toolCalls = firstChoice.message.tool_calls;

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const [firstToolCall, ...remainingToolCalls] = toolCalls;

    return {
      type: "tools",
      calls: [
        parseToolCall(firstToolCall),
        ...remainingToolCalls.map(parseToolCall),
      ],
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
  };
}

async function parseStreamingDecision(
  response: Response,
  onTextDelta: TextDeltaHandler,
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

      if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        continue;
      }

      const choice = payload.choices[0];

      if (!isRecord(choice) || !isRecord(choice.delta)) {
        continue;
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

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return parseDecision({ choices: [{ message }] });
}

export class DeepSeekModel implements AgentModel {
  readonly #apiKey: string;
  readonly #systemPrompt: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("DeepSeek API key must not be empty");
    }

    if (options.systemPrompt.trim() === "") {
      throw new Error("System prompt must not be empty");
    }

    this.#apiKey = options.apiKey;
    this.#systemPrompt = options.systemPrompt;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(
    input: ModelInput,
    signal?: AbortSignal,
    onTextDelta?: TextDeltaHandler,
  ): Promise<Decision> {
    const tools = createTools(input.tools);
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: createMessages(input.events, this.#systemPrompt),
      thinking: { type: "disabled" },
      stream: onTextDelta !== undefined,
    };

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
      return parseStreamingDecision(response, onTextDelta);
    }

    const responseText = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("DeepSeek returned invalid JSON");
    }

    return parseDecision(payload);
  }
}

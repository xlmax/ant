import type {
  AgentEvent,
  AgentModel,
  Decision,
  ModelInput,
  Observation,
  ToolCall,
  ToolSpec,
} from "../agent.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const SYSTEM_PROMPT = [
  "Ты — компонент принятия решений coding-агента, умеющего использовать инструменты.",
  "За один ответ можно вызвать несколько инструментов, только если эти вызовы независимы друг от друга.",
  "Используй инструмент, только если задача требует данных из среды или воздействия на неё. Не вызывай инструменты для повтора, форматирования, перевода, простого вычисления или генерации текста, который можешь дать самостоятельно.",
  "Используй read для чтения файлов вместо cat или sed. Для больших файлов применяй offset и limit.",
  "Используй bash для исследования среды, поиска файлов, запуска программ, тестов и команд Git.",
  "Используй edit для точечных замен: oldText должен точно и уникально совпадать с исходным файлом. Несколько независимых замен в одном файле передавай одним вызовом edit.",
  "Используй write только для новых файлов или полной перезаписи существующих.",
  "После получения результатов инструментов либо вызови следующие необходимые инструменты, либо дай окончательный ответ. Не утверждай, что действие выполнено, если в истории нет подтверждающего результата.",
].join(" ");

interface DeepSeekModelOptions {
  apiKey: string;
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

function createMessages(events: readonly AgentEvent[]): DeepSeekMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
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
    throw new Error("DeepSeek response contains neither a tool call nor text");
  }

  return {
    type: "finish",
    answer: content,
  };
}

export class DeepSeekModel implements AgentModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekModelOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("DeepSeek API key must not be empty");
    }

    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(input: ModelInput, signal?: AbortSignal): Promise<Decision> {
    const tools = createTools(input.tools);
    const body: Record<string, unknown> = {
      model: this.#model,
      messages: createMessages(input.events),
      thinking: { type: "disabled" },
      stream: false,
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
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `DeepSeek API returned ${response.status}: ${responseText.slice(0, 500)}`,
      );
    }

    let payload: unknown;

    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("DeepSeek returned invalid JSON");
    }

    return parseDecision(payload);
  }
}

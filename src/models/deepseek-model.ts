import { readFile } from "node:fs/promises";

import { ModelRequestError } from "../core/agent.js";
import { estimateContextBudget } from "../core/context-budget.js";
import { activeContextEvents } from "../core/context-events.js";
import type {
  AgentEvent,
  AgentModel,
  Decision,
  ImageAttachment,
  ModelInput,
  ModelActivityHandler,
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
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const COMPACTION_PROMPT = `Составь компактное структурированное резюме предыдущей части сессии coding-агента.
Сохрани цели пользователя, принятые решения, важные факты, изменённые файлы, выполненные команды и их существенные результаты, ошибки, ограничения и незавершённую работу.
Не добавляй новых предположений. Не описывай сам процесс суммаризации. Ответ должен быть самодостаточным контекстом для продолжения работы.`;

interface DeepSeekModelOptions {
  apiKey: string;
  systemPrompt: string;
  model?: string;
  contextWindow?: number;
  supportsImages?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: "low" | "high" | "max";
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

type DeepSeekContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type DeepSeekMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | DeepSeekContentPart[] }
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

async function imagePart(
  attachment: ImageAttachment,
  signal?: AbortSignal,
): Promise<DeepSeekContentPart> {
  signal?.throwIfAborted();
  const content = await readFile(attachment.path, { signal });
  if (content.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image ${attachment.path} exceeds the 32 MiB vision limit`);
  }
  return {
    type: "image_url",
    image_url: {
      url: `data:${attachment.mediaType};base64,${content.toString("base64")}`,
    },
  };
}

function decisionMessage(decision: Decision, includeReasoning: boolean): DeepSeekMessage {
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

async function createMessages(
  events: readonly AgentEvent[],
  systemPrompt: string,
  includeReasoning: boolean,
  includeImages: boolean,
  signal?: AbortSignal,
): Promise<DeepSeekMessage[]> {
  const messages: DeepSeekMessage[] = [{ role: "system", content: systemPrompt }];
  let pending:
    | { decision: Extract<Decision, { type: "tools" }>; observations: Map<string, Observation> }
    | undefined;

  const flushPending = async (interrupted = false): Promise<void> => {
    if (!pending) {
      return;
    }
    if (!interrupted && pending.observations.size !== pending.decision.calls.length) return;

    messages.push(decisionMessage(pending.decision, includeReasoning));
    const attachments: ImageAttachment[] = [];
    for (const call of pending.decision.calls) {
      const observation = pending.observations.get(call.id) ?? {
        ok: false,
        error: "Tool call was interrupted; execution status is unknown",
      };
      if (observation) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: observationContent(observation),
        });
        attachments.push(...(observation.attachments ?? []));
      }
    }
    if (attachments.length > 0 && includeImages) {
      let totalBytes = 0;
      const imageParts: DeepSeekContentPart[] = [];
      for (const attachment of attachments) {
        totalBytes += attachment.bytes;
        if (totalBytes > MAX_IMAGE_BYTES) {
          throw new Error("Image attachments exceed the 32 MiB request budget");
        }
        imageParts.push(await imagePart(attachment, signal));
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "The preceding tool result includes image attachments. Inspect the images to answer the request.",
          },
          ...imageParts,
        ],
      });
    }
    pending = undefined;
  };

  for (const event of activeContextEvents(events)) {
    switch (event.type) {
      case "task":
      case "user":
        await flushPending(true);
        messages.push({ role: "user", content: event.content });
        break;

      case "decision":
        pending = undefined;
        if (event.decision.type === "tools") {
          pending = { decision: event.decision, observations: new Map() };
        } else {
          messages.push(decisionMessage(event.decision, includeReasoning));
        }
        break;

      case "compaction":
        pending = undefined;
        messages.push({
          role: "user",
          content: `Ниже дано резюме предыдущей части этой сессии. Используй его как контекст для продолжения работы.\n\n${event.summary}`,
        });
        break;

      case "observation":
        if (pending && pending.decision.calls.some((call) => call.id === event.call.id)) {
          pending.observations.set(event.call.id, event.observation);
          await flushPending();
        }
        break;

      case "model.requested":
      case "model.retry":
      case "model.usage":
      case "tool.started":
      case "tool.output":
      case "tool.finished":
        break;
    }
  }

  await flushPending(true);
  return messages;
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

function parseUsage(payload: unknown, metadata: ModelMetadata): ModelUsage | undefined {
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

function parseModelList(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("DeepSeek returned an invalid model list");
  }

  return payload.data
    .filter(isRecord)
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .sort((left, right) => left.localeCompare(right));
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
      calls: [parseToolCall(firstToolCall), ...remainingToolCalls.map(parseToolCall)],
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  const content = firstChoice.message.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(
      `DeepSeek response contains neither a tool call nor text: ${JSON.stringify(firstChoice).slice(
        0,
        500,
      )}`,
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
  onActivity: ModelActivityHandler | undefined,
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
      onActivity?.();
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
          typeof partialCall.index === "number" && partialCall.index >= 0 ? partialCall.index : 0;
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
  readonly #thinkingEnabled: boolean;
  readonly #supportsImages: boolean;
  readonly #reasoningEffort: "low" | "high" | "max";
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
    this.#thinkingEnabled = options.thinkingEnabled ?? true;
    this.#supportsImages = options.supportsImages ?? false;
    this.#reasoningEffort = options.reasoningEffort ?? "high";
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    const request: RequestInit = {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#apiKey}` },
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.#fetchResponse(`${this.#baseUrl}/models`, request);
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`DeepSeek API returned ${response.status}: ${responseText.slice(0, 500)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("DeepSeek returned invalid JSON");
    }

    return parseModelList(payload);
  }

  async decide(
    input: ModelInput,
    signal?: AbortSignal,
    onTextDelta?: TextDeltaHandler,
    onReasoningDelta?: ReasoningDeltaHandler,
    onUsage?: ModelUsageHandler,
    onActivity?: ModelActivityHandler,
  ): Promise<Decision> {
    const tools = createTools(input.tools);
    const budget = estimateContextBudget({
      systemPrompt: this.#systemPrompt,
      events: input.events,
      tools: input.tools,
      contextWindow: this.#contextWindow,
      includeImages: this.#supportsImages,
      includeReasoning: this.#thinkingEnabled,
    });
    if (budget.estimatedTokens >= this.#contextWindow) {
      throw new Error(
        `Estimated input context (${budget.estimatedTokens} tokens) exceeds the configured context window (${this.#contextWindow}). Start a new session or reduce the saved context.`,
      );
    }
    const messages = await createMessages(
      input.events,
      this.#systemPrompt,
      this.#thinkingEnabled,
      this.#supportsImages,
      signal,
    );
    const body: Record<string, unknown> = {
      model: this.#model,
      messages,
      thinking: { type: this.#thinkingEnabled ? "enabled" : "disabled" },
      stream: onTextDelta !== undefined,
    };

    if (this.#thinkingEnabled) {
      body.reasoning_effort = this.#reasoningEffort;
    }

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

    const response = await this.#fetchResponse(`${this.#baseUrl}/chat/completions`, request);
    if (!response.ok) {
      const responseText = await response.text();
      throw new ModelRequestError(
        `DeepSeek API returned ${response.status}: ${responseText.slice(0, 500)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    if (onTextDelta) {
      return parseStreamingDecision(response, onTextDelta, onReasoningDelta, onUsage, onActivity, {
        provider: "deepseek",
        model: this.#model,
        reasoning: this.#thinkingEnabled ? this.#reasoningEffort : "off",
        contextWindow: this.#contextWindow,
      });
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
      reasoning: this.#thinkingEnabled ? this.#reasoningEffort : "off",
      contextWindow: this.#contextWindow,
    });
    if (usage) {
      onUsage?.(usage);
    }

    return parseDecision(payload);
  }

  async summarize(events: readonly AgentEvent[], signal?: AbortSignal): Promise<string> {
    const summaryEvents: AgentEvent[] = [...events, { type: "user", content: COMPACTION_PROMPT }];
    const budget = estimateContextBudget({
      systemPrompt: this.#systemPrompt,
      events: summaryEvents,
      tools: [],
      contextWindow: this.#contextWindow,
      includeImages: this.#supportsImages,
      includeReasoning: false,
    });
    if (budget.estimatedTokens >= this.#contextWindow) {
      throw new Error(
        `The context selected for compaction is too large (${budget.estimatedTokens}/${this.#contextWindow} estimated tokens). Compact the session earlier or start a new session.`,
      );
    }

    const messages = await createMessages(
      events,
      this.#systemPrompt,
      false,
      this.#supportsImages,
      signal,
    );
    messages.push({ role: "user", content: COMPACTION_PROMPT });
    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        messages,
        thinking: { type: "disabled" },
        stream: false,
        max_tokens: 4_096,
      }),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.#fetchResponse(`${this.#baseUrl}/chat/completions`, request);
    const responseText = await response.text();
    if (!response.ok) {
      throw new ModelRequestError(
        `DeepSeek API returned ${response.status}: ${responseText.slice(0, 500)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("DeepSeek returned invalid JSON");
    }
    const decision = parseDecision(payload);
    if (decision.type !== "finish") {
      throw new Error("DeepSeek returned tool calls while compacting without tools");
    }
    return decision.answer.trim();
  }

  async #fetchResponse(url: string, request: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, request);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ModelRequestError(`Сетевая ошибка: ${error.message}`, true);
      }
      throw error;
    }
  }
}

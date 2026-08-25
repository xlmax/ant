import { ModelRequestError } from "../core/agent.js";
import { estimateContextBudget } from "../core/context-budget.js";
import type {
  AgentModel,
  ModelInput,
  ModelActivityHandler,
  ModelUsageHandler,
  ReasoningDeltaHandler,
  TextDeltaHandler,
} from "../core/agent.js";
import { buildMessages } from "./deepseek/message-builder.js";
import { createTools, parseDecision, parseModelList, parseUsage } from "./deepseek/protocol.js";
import { parseStreamingDecision } from "./deepseek/stream-parser.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
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
    if (options.apiKey.trim() === "") throw new Error("DeepSeek API key must not be empty");
    if (options.systemPrompt.trim() === "") throw new Error("System prompt must not be empty");
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
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    const response = await this.#fetchResponse(`${this.#baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#apiKey}` },
      ...(signal === undefined ? {} : { signal }),
    });
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
  ) {
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

    const messages = await buildMessages(
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
    if (this.#thinkingEnabled) body.reasoning_effort = this.#reasoningEffort;
    if (onTextDelta) body.stream_options = { include_usage: true };

    const response = await this.#fetchResponse(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        ...body,
        ...(input.tools.length === 0
          ? {}
          : { tools: createTools(input.tools), tool_choice: "auto" }),
      }),
      ...(signal === undefined ? {} : { signal }),
    });

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
    if (usage) onUsage?.(usage);
    return parseDecision(payload);
  }

  async summarize(
    events: Parameters<typeof buildMessages>[0],
    signal?: AbortSignal,
  ): Promise<string> {
    const summaryEvents = [...events, { type: "user" as const, content: COMPACTION_PROMPT }];
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

    const messages = await buildMessages(
      events,
      this.#systemPrompt,
      false,
      this.#supportsImages,
      signal,
    );
    messages.push({ role: "user", content: COMPACTION_PROMPT });
    const response = await this.#fetchResponse(`${this.#baseUrl}/chat/completions`, {
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
    });
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

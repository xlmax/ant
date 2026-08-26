import type {
  Environment,
  ImageAttachment,
  Observation,
  SingleToolOutputHandler,
  ToolCall,
  ToolOutputHandler,
  ToolStartedHandler,
  ToolSpec,
} from "../core/agent.js";

export interface ToolExecutionResult {
  kind: "tool-result";
  value: unknown;
  attachments: readonly ImageAttachment[];
}

export interface Tool {
  spec: ToolSpec;
  parallelSafe?: boolean;
  execute(
    input: unknown,
    signal?: AbortSignal,
    onOutput?: SingleToolOutputHandler,
  ): Promise<unknown | ToolExecutionResult>;
}

function isToolExecutionResult(value: unknown): value is ToolExecutionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "tool-result" &&
    "value" in value &&
    "attachments" in value &&
    Array.isArray(value.attachments)
  );
}

export class ToolEnvironment implements Environment {
  readonly #tools: Map<string, Tool>;

  constructor(tools: readonly Tool[]) {
    this.#tools = new Map();

    for (const tool of tools) {
      if (this.#tools.has(tool.spec.name)) {
        throw new Error(`Duplicate tool: ${tool.spec.name}`);
      }

      this.#tools.set(tool.spec.name, tool);
    }
  }

  tools(): readonly ToolSpec[] {
    return [...this.#tools.values()].map((tool) => tool.spec);
  }

  async execute(
    call: ToolCall,
    signal?: AbortSignal,
    onOutput?: SingleToolOutputHandler,
  ): Promise<Observation> {
    const tool = this.#tools.get(call.name);

    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    try {
      const result = await tool.execute(call.input, signal, onOutput);
      if (isToolExecutionResult(result)) {
        return {
          ok: true,
          value: result.value,
          ...(result.attachments === undefined ? {} : { attachments: result.attachments }),
        };
      }
      return { ok: true, value: result };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async executeMany(
    calls: readonly [ToolCall, ...ToolCall[]],
    signal?: AbortSignal,
    onOutput?: ToolOutputHandler,
    onStarted?: ToolStartedHandler,
  ): Promise<readonly Observation[]> {
    const canRunInParallel = calls.every(
      (call) => this.#tools.get(call.name)?.parallelSafe === true,
    );
    if (canRunInParallel) {
      return Promise.all(
        calls.map((call) => {
          onStarted?.(call);
          return this.execute(call, signal, (output) => onOutput?.(call, output));
        }),
      );
    }

    const observations: Observation[] = [];
    for (const call of calls) {
      onStarted?.(call);
      observations.push(await this.execute(call, signal, (output) => onOutput?.(call, output)));
    }
    return observations;
  }
}

import type { Environment, ImageAttachment, Observation, ToolCall, ToolSpec } from "./agent.js";

export interface ToolExecutionResult {
  kind: "tool-result";
  value: unknown;
  attachments: readonly ImageAttachment[];
}

export interface Tool {
  spec: ToolSpec;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown | ToolExecutionResult>;
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

  async execute(call: ToolCall, signal?: AbortSignal): Promise<Observation> {
    const tool = this.#tools.get(call.name);

    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    try {
      const result = await tool.execute(call.input, signal);
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
}

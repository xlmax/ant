import type {
  Environment,
  Observation,
  ToolCall,
  ToolSpec,
} from "./agent.js";

export interface Tool {
  spec: ToolSpec;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
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
  ): Promise<Observation> {
    const tool = this.#tools.get(call.name);

    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    try {
      const value = await tool.execute(call.input, signal);
      return { ok: true, value };
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

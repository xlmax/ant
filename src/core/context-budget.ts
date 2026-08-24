import type { AgentEvent, ToolSpec } from "./agent.js";

const BYTES_PER_TOKEN = 4;

export interface HeavyObservation {
  callId: string;
  tool: string;
  estimatedTokens: number;
}

export interface ContextBudget {
  contextWindow: number;
  estimatedTokens: number;
  percentage: number;
  breakdown: {
    systemPrompt: number;
    messages: number;
    toolResults: number;
    toolSchemas: number;
    images: number;
  };
  heavyObservations: HeavyObservation[];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(serializedBytes(value) / BYTES_PER_TOKEN);
}

function estimateImageTokens(event: Extract<AgentEvent, { type: "observation" }>): number {
  return (event.observation.attachments ?? []).reduce(
    (total, attachment) => total + Math.ceil(attachment.bytes / 3),
    0,
  );
}

export function estimateContextBudget(options: {
  systemPrompt: string;
  events: readonly AgentEvent[];
  tools: readonly ToolSpec[];
  contextWindow: number;
  includeImages?: boolean;
  includeReasoning?: boolean;
}): ContextBudget {
  const breakdown = {
    systemPrompt: estimateTokens(options.systemPrompt),
    messages: 0,
    toolResults: 0,
    toolSchemas: estimateTokens(options.tools),
    images: 0,
  };
  const heavyObservations: HeavyObservation[] = [];

  for (const event of options.events) {
    switch (event.type) {
      case "task":
      case "user":
        breakdown.messages += estimateTokens(event);
        break;

      case "decision": {
        if (options.includeReasoning === false && event.decision.reasoning !== undefined) {
          const decision: typeof event.decision = { ...event.decision };
          delete decision.reasoning;
          breakdown.messages += estimateTokens({ ...event, decision });
        } else {
          breakdown.messages += estimateTokens(event);
        }
        break;
      }

      case "observation": {
        const resultTokens = estimateTokens(event.observation);
        const imageTokens = options.includeImages === false ? 0 : estimateImageTokens(event);
        breakdown.toolResults += resultTokens;
        breakdown.images += imageTokens;
        heavyObservations.push({
          callId: event.call.id,
          tool: event.call.name,
          estimatedTokens: resultTokens + imageTokens,
        });
        break;
      }

      case "model.requested":
      case "model.retry":
      case "model.usage":
      case "tool.started":
      case "tool.output":
      case "tool.finished":
        break;
    }
  }

  const estimatedTokens = Object.values(breakdown).reduce((total, value) => total + value, 0);
  return {
    contextWindow: options.contextWindow,
    estimatedTokens,
    percentage: (estimatedTokens / options.contextWindow) * 100,
    breakdown,
    heavyObservations: heavyObservations
      .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
      .slice(0, 5),
  };
}

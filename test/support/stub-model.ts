import type {
  AgentEvent,
  AgentModel,
  Decision,
  ModelInput,
} from "../../packages/core/src/agent.js";

function findLastObservation(
  events: readonly AgentEvent[],
): Extract<AgentEvent, { type: "observation" }> | undefined {
  return events.findLast(
    (event): event is Extract<AgentEvent, { type: "observation" }> => event.type === "observation",
  );
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class StubModel implements AgentModel {
  async decide(input: ModelInput): Promise<Decision> {
    const observation = findLastObservation(input.events);

    if (observation) {
      if (!observation.observation.ok) {
        return {
          type: "finish",
          answer: `Заглушка получила ошибку: ${observation.observation.error}`,
        };
      }

      return {
        type: "finish",
        answer: `Заглушка получила результат: ${formatValue(observation.observation.value)}`,
      };
    }

    const task = input.events.find(
      (event): event is Extract<AgentEvent, { type: "task" }> => event.type === "task",
    );

    if (!task) {
      throw new Error("Заглушке не передана задача");
    }

    return {
      type: "tools",
      calls: [
        {
          id: "stub-echo-1",
          name: "echo",
          input: { text: task.content },
        },
      ],
    };
  }
}

import type { Tool } from "./environment.js";

export const echoTool: Tool = {
  spec: {
    name: "echo",
    description: "Returns the provided text without changing it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },

  async execute(input: unknown): Promise<unknown> {
    if (
      typeof input !== "object" ||
      input === null ||
      !("text" in input) ||
      typeof input.text !== "string"
    ) {
      throw new Error("echo expects an object with a string property 'text'");
    }

    return { text: input.text };
  },
};

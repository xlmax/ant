import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, ModelInput } from "../src/core/agent.js";
import { DeepSeekModel } from "../src/models/deepseek-model.js";

test("DeepSeekModel maps tool calls and observations to the API protocol", async () => {
  const responses = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-42",
                type: "function",
                function: {
                  name: "echo",
                  arguments: '{"text":"Привет"}',
                },
              },
              {
                id: "call-43",
                type: "function",
                function: {
                  name: "echo",
                  arguments: '{"text":"Мир"}',
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Готово",
          },
        },
      ],
    },
  ];
  const requests: RequestInit[] = [];
  let responseIndex = 0;

  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push(init ?? {});
    const body = responses[responseIndex];
    responseIndex += 1;

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    fetch: fetchMock,
  });
  const events: AgentEvent[] = [{ type: "task", content: "Поздоровайся" }];
  const input: ModelInput = {
    events,
    tools: [
      {
        name: "echo",
        description: "Returns text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  };

  const toolDecision = await model.decide(input);

  assert.deepEqual(toolDecision, {
    type: "tools",
    calls: [
      {
        id: "call-42",
        name: "echo",
        input: { text: "Привет" },
      },
      {
        id: "call-43",
        name: "echo",
        input: { text: "Мир" },
      },
    ],
  });

  if (toolDecision.type !== "tools") {
    return;
  }

  const firstCall = toolDecision.calls[0];
  const secondCall = toolDecision.calls[1];
  assert.ok(secondCall);

  events.push(
    { type: "decision", decision: toolDecision },
    {
      type: "observation",
      call: firstCall,
      observation: { ok: true, value: { text: "Привет" } },
    },
    {
      type: "observation",
      call: secondCall,
      observation: { ok: true, value: { text: "Мир" } },
    },
  );

  const finalDecision = await model.decide(input);

  assert.deepEqual(finalDecision, {
    type: "finish",
    answer: "Готово",
  });
  assert.equal(requests.length, 2);

  const secondRequestBody = JSON.parse(String(requests[1]?.body));
  assert.deepEqual(secondRequestBody.messages.slice(-3), [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-42",
          type: "function",
          function: {
            name: "echo",
            arguments: '{"text":"Привет"}',
          },
        },
        {
          id: "call-43",
          type: "function",
          function: {
            name: "echo",
            arguments: '{"text":"Мир"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-42",
      content: '{"ok":true,"value":{"text":"Привет"}}',
    },
    {
      role: "tool",
      tool_call_id: "call-43",
      content: '{"ok":true,"value":{"text":"Мир"}}',
    },
  ]);
});

test("DeepSeekModel streams text deltas and returns the final decision", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"Гото"}}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"во"}}]}\n\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  let request: RequestInit | undefined;
  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = init;
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    fetch: fetchMock,
  });
  const deltas: string[] = [];

  const decision = await model.decide(
    {
      events: [{ type: "task", content: "Ответь" }],
      tools: [],
    },
    undefined,
    (text) => deltas.push(text),
  );

  assert.deepEqual(deltas, ["Гото", "во"]);
  assert.deepEqual(decision, { type: "finish", answer: "Готово" });
  assert.equal(JSON.parse(String(request?.body)).stream, true);
});

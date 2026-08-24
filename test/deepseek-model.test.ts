import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelRequestError, type AgentEvent, type ModelInput } from "../src/core/agent.js";
import { DeepSeekModel } from "../src/models/deepseek-model.js";

test("DeepSeekModel classifies fetch TypeError as retryable transport failure", async () => {
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "You are a test assistant.",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    model.decide({ events: [{ type: "task", content: "Проверь сеть" }], tools: [] }),
    (error: unknown) =>
      error instanceof ModelRequestError &&
      error.retryable &&
      /Сетевая ошибка: fetch failed/u.test(error.message),
  );
});

test("DeepSeekModel maps tool calls and observations to the API protocol", async () => {
  const responses = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "Нужно вызвать echo.",
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
    reasoning: "Нужно вызвать echo.",
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
      reasoning_content: "Нужно вызвать echo.",
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
        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"Сначала "}}]}\n\n'),
      );
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"подумаю."}}]}\n\n'),
      );
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Гото"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"во"}}]}\n\n'));
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[],"usage":{"prompt_tokens":24100,"completion_tokens":1040,"total_tokens":25140}}\n\n',
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
  const reasoningDeltas: string[] = [];
  const usages: unknown[] = [];

  const decision = await model.decide(
    {
      events: [{ type: "task", content: "Ответь" }],
      tools: [],
    },
    undefined,
    (text) => deltas.push(text),
    (text) => reasoningDeltas.push(text),
    (usage) => usages.push(usage),
  );

  assert.deepEqual(deltas, ["Гото", "во"]);
  assert.deepEqual(reasoningDeltas, ["Сначала ", "подумаю."]);
  assert.deepEqual(usages, [
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoning: "high",
      inputTokens: 24100,
      outputTokens: 1040,
      totalTokens: 25140,
      contextWindow: 1_000_000,
      source: "provider",
    },
  ]);
  assert.deepEqual(decision, {
    type: "finish",
    answer: "Готово",
    reasoning: "Сначала подумаю.",
  });
  const requestBody = JSON.parse(String(request?.body));
  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.thinking, { type: "enabled" });
  assert.equal(requestBody.reasoning_effort, "high");
  assert.deepEqual(requestBody.stream_options, { include_usage: true });
});

test("DeepSeekModel preserves completed calls and marks missing observations as interrupted", async () => {
  let request: RequestInit | undefined;
  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Продолжаем" } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    fetch: fetchMock,
  });
  const firstCall = { id: "call-completed", name: "echo", input: { text: "x" } };
  const secondCall = { id: "call-interrupted", name: "echo", input: { text: "y" } };

  await model.decide({
    events: [
      { type: "task", content: "Сделай работу" },
      { type: "decision", decision: { type: "tools", calls: [firstCall, secondCall] } },
      {
        type: "observation",
        call: firstCall,
        observation: { ok: true, value: { text: "x" } },
      },
      { type: "user", content: "Продолжай" },
    ],
    tools: [],
  });

  const body = JSON.parse(String(request?.body));
  assert.deepEqual(body.messages, [
    { role: "system", content: "Тестовая системная инструкция." },
    { role: "user", content: "Сделай работу" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-completed",
          type: "function",
          function: { name: "echo", arguments: '{"text":"x"}' },
        },
        {
          id: "call-interrupted",
          type: "function",
          function: { name: "echo", arguments: '{"text":"y"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-completed",
      content: '{"ok":true,"value":{"text":"x"}}',
    },
    {
      role: "tool",
      tool_call_id: "call-interrupted",
      content: '{"ok":false,"error":"Tool call was interrupted; execution status is unknown"}',
    },
    { role: "user", content: "Продолжай" },
  ]);
});

test("DeepSeekModel rejects an estimated input larger than the configured context", async () => {
  let requested = false;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "A deliberately long system prompt for a tiny context window.",
    contextWindow: 10,
    fetch: (async () => {
      requested = true;
      return new Response();
    }) as typeof fetch,
  });

  await assert.rejects(
    model.decide({ events: [{ type: "task", content: "work" }], tools: [] }),
    /exceeds the configured context window/u,
  );
  assert.equal(requested, false);
});

test("DeepSeekModel omits saved reasoning when thinking is disabled", async () => {
  let request: RequestInit | undefined;
  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Готово" } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    thinkingEnabled: false,
    fetch: fetchMock,
  });

  await model.decide({
    events: [
      { type: "task", content: "Начни" },
      {
        type: "decision",
        decision: { type: "finish", answer: "Первый ответ", reasoning: "Скрытая цепочка" },
      },
      { type: "user", content: "Продолжай" },
    ],
    tools: [],
  });

  const body = JSON.parse(String(request?.body));
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.messages[2], {
    role: "assistant",
    content: "Первый ответ",
  });
});

test("DeepSeekModel forwards image tool results to a vision model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ant-image-"));
  const imagePath = join(directory, "screen.png");
  const image = Buffer.from("89504e470d0a1a0a00000000", "hex");
  let request: RequestInit | undefined;
  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "На изображении экран." } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    await writeFile(imagePath, image);
    const model = new DeepSeekModel({
      apiKey: "test-key",
      systemPrompt: "Тестовая системная инструкция.",
      model: "custom-vision-model",
      supportsImages: true,
      fetch: fetchMock,
    });
    const call = { id: "read-image", name: "read", input: { path: imagePath } };

    await model.decide({
      events: [
        { type: "task", content: "Опиши изображение" },
        { type: "decision", decision: { type: "tools", calls: [call] } },
        {
          type: "observation",
          call,
          observation: {
            ok: true,
            value: { path: imagePath, kind: "image" },
            attachments: [
              {
                type: "image",
                path: imagePath,
                mediaType: "image/png",
                bytes: image.length,
              },
            ],
          },
        },
      ],
      tools: [],
    });

    const body = JSON.parse(String(request?.body));
    assert.deepEqual(body.messages.at(-1), {
      role: "user",
      content: [
        {
          type: "text",
          text: "The preceding tool result includes image attachments. Inspect the images to answer the request.",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
        },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DeepSeekModel keeps image observations textual for a non-vision model", async () => {
  let request: RequestInit | undefined;
  const fetchMock = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    request = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Не могу просмотреть изображение." } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    model: "deepseek-v4-flash",
    fetch: fetchMock,
  });
  const call = { id: "read-image", name: "read", input: { path: "missing.png" } };

  await model.decide({
    events: [
      { type: "task", content: "Опиши изображение" },
      { type: "decision", decision: { type: "tools", calls: [call] } },
      {
        type: "observation",
        call,
        observation: {
          ok: true,
          value: { kind: "image" },
          attachments: [
            {
              type: "image",
              path: "missing.png",
              mediaType: "image/png",
              bytes: 1,
            },
          ],
        },
      },
    ],
    tools: [],
  });

  const body = JSON.parse(String(request?.body));
  assert.equal(
    body.messages.some((message: { content: unknown }) => Array.isArray(message.content)),
    false,
  );
});

test("DeepSeekModel lists provider models without starting a completion", async () => {
  let url = "";
  let request: RequestInit | undefined;
  const fetchMock = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    url = String(input);
    request = init;
    return new Response(
      JSON.stringify({
        data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    systemPrompt: "Тестовая системная инструкция.",
    fetch: fetchMock,
  });

  assert.deepEqual(await model.listModels(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(url, "https://api.deepseek.com/models");
  assert.equal(request?.method, "GET");
  assert.deepEqual(request?.headers, { Authorization: "Bearer test-key" });
});

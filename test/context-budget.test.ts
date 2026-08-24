import assert from "node:assert/strict";
import test from "node:test";

import { estimateContextBudget, estimateTokens } from "../src/core/context-budget.js";
import { configureAnsi } from "../src/ui/ansi.js";
import { formatContextStatus } from "../src/ui/context-status.js";

test("context budget separates messages, tool results, schemas, and images", () => {
  const call = { id: "read-1", name: "read", input: { path: "large.txt" } };
  const budget = estimateContextBudget({
    systemPrompt: "System prompt",
    contextWindow: 10_000,
    includeImages: true,
    tools: [{ name: "read", description: "Reads a file", inputSchema: { type: "object" } }],
    events: [
      { type: "task", content: "Inspect the file" },
      { type: "decision", decision: { type: "tools", calls: [call] } },
      {
        type: "observation",
        call,
        observation: {
          ok: true,
          value: { content: "x".repeat(4_000) },
          attachments: [
            { type: "image", path: "cached.png", mediaType: "image/png", bytes: 3_000 },
          ],
        },
      },
      { type: "tool.output", call, output: { stream: "stdout", content: "ignored" } },
    ],
  });

  assert.ok(budget.breakdown.systemPrompt > 0);
  assert.ok(budget.breakdown.messages > 0);
  assert.ok(budget.breakdown.toolResults >= 1_000);
  assert.equal(budget.breakdown.images, 1_000);
  assert.ok(budget.breakdown.toolSchemas > 0);
  assert.equal(budget.heavyObservations[0]?.callId, "read-1");
  assert.equal(
    budget.heavyObservations[0]?.estimatedTokens,
    budget.breakdown.toolResults + budget.breakdown.images,
  );
  assert.equal(
    budget.estimatedTokens,
    Object.values(budget.breakdown).reduce((total, value) => total + value, 0),
  );
});

test("context budget excludes image payloads for a text-only model", () => {
  const call = { id: "image-1", name: "read", input: { path: "screen.png" } };
  const budget = estimateContextBudget({
    systemPrompt: "System",
    contextWindow: 10_000,
    includeImages: false,
    tools: [],
    events: [
      {
        type: "observation",
        call,
        observation: {
          ok: true,
          attachments: [
            { type: "image", path: "cached.png", mediaType: "image/png", bytes: 30_000 },
          ],
        },
      },
    ],
  });
  assert.equal(budget.breakdown.images, 0);
});

test("context budget excludes saved reasoning when thinking is disabled", () => {
  const event = {
    type: "decision" as const,
    decision: { type: "finish" as const, answer: "short", reasoning: "x".repeat(4_000) },
  };
  const withReasoning = estimateContextBudget({
    systemPrompt: "System",
    contextWindow: 10_000,
    includeReasoning: true,
    tools: [],
    events: [event],
  });
  const withoutReasoning = estimateContextBudget({
    systemPrompt: "System",
    contextWindow: 10_000,
    includeReasoning: false,
    tools: [],
    events: [event],
  });
  assert.ok(withReasoning.breakdown.messages > withoutReasoning.breakdown.messages + 900);
});

test("token estimation uses serialized UTF-8 bytes", () => {
  assert.equal(estimateTokens("abcd"), 2);
  assert.ok(estimateTokens("€€€€") > estimateTokens("aaaa"));
});

test("context status reports a warning and the largest observations", () => {
  configureAnsi(false);
  try {
    const status = formatContextStatus({
      contextWindow: 1_000,
      estimatedTokens: 850,
      percentage: 85,
      breakdown: {
        systemPrompt: 100,
        messages: 200,
        toolResults: 500,
        toolSchemas: 50,
        images: 0,
      },
      heavyObservations: [{ callId: "bash-1", tool: "bash", estimatedTokens: 500 }],
    });

    assert.match(status, /Контекст: ~850 \/ 1\.0k \(85\.0%\)/u);
    assert.match(status, /bash \(bash-1\): ~500/u);
    assert.match(status, /приближается/u);
    assert.match(status, /приблизительная/u);
  } finally {
    configureAnsi(true);
  }
});

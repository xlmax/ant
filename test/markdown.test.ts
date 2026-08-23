import assert from "node:assert/strict";
import test from "node:test";

import { StreamingMarkdownRenderer } from "../src/ui/markdown.js";

test("streaming markdown renderer buffers incomplete lines", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(renderer.push("# Заг"), "");
  assert.equal(renderer.push("оловок\n- элемент\n"), "Заголовок\n• элемент\n");
});

test("streaming markdown renderer formats inline markdown", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(
    renderer.push("**Важно**: используй `read` для файлов.\n"),
    "Важно: используй read для файлов.\n",
  );
});

test("streaming markdown renderer formats code fences", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(
    renderer.push("```ts\nconst value = 1;\n```\n"),
    "┌─ code: ts\n  const value = 1;\n└─\n",
  );
});

test("streaming markdown renderer aligns a completed table", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(
    renderer.push(
      "| Модель | Контекст |\n| :--- | ---: |\n| deepseek-v4-flash | 1M |\n| deepseek-v4-pro | 1M |\n",
    ),
    "",
  );
  assert.equal(
    renderer.finish(),
    [
      "  Модель             Контекст",
      "  ─────────────────  ────────",
      "  deepseek-v4-flash        1M",
      "  deepseek-v4-pro          1M",
    ].join("\n"),
  );
});

test("table-like text without a separator remains ordinary text", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(renderer.push("значение | комментарий\nобычная строка\n"), "значение | комментарий\nобычная строка\n");
});

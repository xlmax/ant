import assert from "node:assert/strict";
import test from "node:test";

import { displayWidth } from "../src/ui/display-width.js";
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

test("streaming markdown renderer supports nested inline markdown", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(renderer.push("**bold *italic*** and `a*b`\n"), "bold italic and a*b\n");
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

test("streaming markdown renderer truncates wide tables to one terminal row per record", () => {
  const renderer = new StreamingMarkdownRenderer({ maxTableWidth: () => 28 });

  renderer.push(
    "| Инструмент | Выполненная команда |\n| --- | --- |\n| bash | npm run test:integration with extras |\n",
  );
  const rendered = renderer.finish();
  const lines = rendered.split("\n");

  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => displayWidth(line) <= 28));
  assert.match(rendered, /…/u);
  assert.match(rendered, /bash/u);
});

test("streaming markdown renderer hides excess columns in a very narrow terminal", () => {
  const renderer = new StreamingMarkdownRenderer({ maxTableWidth: () => 8 });

  renderer.push("| one | two | three |\n| --- | --- | --- |\n| a | b | c |\n");
  const lines = renderer.finish().split("\n");

  assert.ok(lines.every((line) => displayWidth(line) <= 8));
  assert.match(lines[0] ?? "", /…/u);
  assert.equal(lines.length, 3);
});

test("streaming markdown renderer aligns wide Unicode table cells", () => {
  const renderer = new StreamingMarkdownRenderer();

  renderer.push("| Иконка | Значение |\n| --- | --- |\n| 🧠 | готово |\n");
  const lines = renderer.finish().split("\n");

  assert.equal(displayWidth(lines[0] ?? ""), displayWidth(lines[1] ?? ""));
  assert.equal(displayWidth(lines[1] ?? ""), displayWidth(lines[2] ?? ""));
});

test("table-like text without a separator remains ordinary text", () => {
  const renderer = new StreamingMarkdownRenderer();

  assert.equal(
    renderer.push("значение | комментарий\nобычная строка\n"),
    "значение | комментарий\nобычная строка\n",
  );
});

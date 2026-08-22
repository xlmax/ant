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

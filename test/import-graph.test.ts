import assert from "node:assert/strict";
import test from "node:test";

import { parseModuleReferences } from "./support/import-graph.js";

test("TypeScript import parser covers static, type-only, dynamic, and import-equals forms", () => {
  const source = `
    import value from "./value.js";
    import type { Shape } from "./shape.js";
    import { type NamedShape } from "./named-shape.js";
    import { type Input, output } from "./mixed.js";
    export { result } from "./result.js";
    export type { ResultShape } from "./result-shape.js";
    export { type NamedResult } from "./named-result.js";
    type LazyType = import("./lazy-type.js").LazyType;
    const lazy = import("./lazy.js");
    const opaque = import(moduleName);
    import legacy = require("./legacy.js");
  `;

  assert.deepEqual(parseModuleReferences(source), [
    { specifier: "./value.js", runtime: true },
    { specifier: "./shape.js", runtime: false },
    { specifier: "./named-shape.js", runtime: true },
    { specifier: "./mixed.js", runtime: true },
    { specifier: "./result.js", runtime: true },
    { specifier: "./result-shape.js", runtime: false },
    { specifier: "./named-result.js", runtime: true },
    { specifier: "./lazy-type.js", runtime: false },
    { specifier: "./lazy.js", runtime: true },
    { specifier: undefined, runtime: true },
    { specifier: "./legacy.js", runtime: true },
  ]);
});

test("TypeScript import parser ignores import-like comments and string literals", () => {
  const source = `
    // import "./comment.js";
    const example = 'import("./string.js")';
    const another = "export { value } from './other-string.js'";
  `;

  assert.deepEqual(parseModuleReferences(source), []);
});

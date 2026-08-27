import assert from "node:assert/strict";
import test from "node:test";

import type { Tool, ToolContext, ToolPack } from "../src/app/tools.js";
import { ToolRegistry } from "../src/app/tool-registry.js";
import { codingToolPack } from "../src/tools/coding-tool-pack.js";
import { ToolEnvironment } from "../src/tools/tool-environment.js";

const context: ToolContext = {
  workspace: process.cwd(),
  capabilities: new Set(["filesystem.read", "filesystem.write", "process.spawn"]),
  process: {},
  logger: { debug() {} },
};

function tool(
  name: string,
  ownerId: string,
  options: { parallelSafe?: boolean; sideEffects?: "none" | "workspace" | "process" } = {},
): Tool {
  return {
    metadata: {
      ownerId,
      parallelSafe: options.parallelSafe ?? true,
      sideEffects: options.sideEffects ?? "none",
      requiredCapabilities: [],
    },
    spec: { name, description: name, inputSchema: { type: "object" } },
    async execute() {
      return name;
    },
  };
}

function pack(id: string, tools: readonly Tool[]): ToolPack {
  return { id, create: () => tools };
}

test("tool registry composes independent packs in registration order", () => {
  const registry = new ToolRegistry();
  registry.register(pack("first", [tool("one", "first")]));
  registry.register(pack("second", [tool("two", "second")]));

  assert.deepEqual(
    registry.createTools(context).map((item) => item.spec.name),
    ["one", "two"],
  );
});

test("tool registry rejects duplicate packs, empty packs and mismatched owners", () => {
  const duplicate = new ToolRegistry();
  duplicate.register(pack("same", [tool("one", "same")]));
  assert.throws(() => duplicate.register(pack("same", [tool("two", "same")])), /same/u);

  const empty = new ToolRegistry();
  empty.register(pack("empty", []));
  assert.throws(() => empty.createTools(context), /empty.*no tools/iu);

  const mismatch = new ToolRegistry();
  mismatch.register(pack("declared", [tool("one", "different")]));
  assert.throws(() => mismatch.createTools(context), /declared.*different/iu);
});

test("tool registry diagnoses name conflicts with both owners", () => {
  const registry = new ToolRegistry();
  registry.register(pack("alpha", [tool("shared", "alpha")]));
  registry.register(pack("beta", [tool("shared", "beta")]));

  assert.throws(() => registry.createTools(context), /shared.*alpha.*beta/iu);
});

test("tool registry validates required platform capabilities", () => {
  const registry = new ToolRegistry();
  const base = tool("shell", "process-pack");
  const restricted: Tool = {
    ...base,
    metadata: { ...base.metadata, requiredCapabilities: ["process.spawn"] },
  };
  registry.register(pack("process-pack", [restricted]));

  assert.throws(
    () => registry.createTools({ ...context, capabilities: new Set(["filesystem.read"]) }),
    /shell.*process\.spawn/iu,
  );
});

test("tool environment parallelizes only side-effect-free parallel-safe tools", async () => {
  let active = 0;
  let maximumActive = 0;
  const delayed = (name: string, sideEffects: "none" | "workspace"): Tool => ({
    ...tool(name, "timing", { parallelSafe: true, sideEffects }),
    async execute() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return name;
    },
  });

  const parallel = new ToolEnvironment([delayed("read", "none")]);
  await parallel.executeMany([
    { id: "one", name: "read", input: {} },
    { id: "two", name: "read", input: {} },
  ]);
  assert.equal(maximumActive, 2);

  active = 0;
  maximumActive = 0;
  const sequential = new ToolEnvironment([delayed("write", "workspace")]);
  await sequential.executeMany([
    { id: "one", name: "write", input: {} },
    { id: "two", name: "write", input: {} },
  ]);
  assert.equal(maximumActive, 1);
});

test("built-in coding pack exposes the six existing tools with standard metadata", () => {
  const tools = codingToolPack.create(context);
  assert.deepEqual(
    tools.map((item) => item.spec.name),
    ["read", "glob", "grep", "bash", "edit", "write"],
  );
  assert.ok(tools.every((item) => item.metadata.ownerId === codingToolPack.id));
  assert.ok(tools.every((item) => typeof item.metadata.parallelSafe === "boolean"));
  assert.ok(tools.every((item) => item.metadata.requiredCapabilities.length > 0));
});

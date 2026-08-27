import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_API_VERSION,
  ModuleRegistry,
  moduleDescriptor,
  type AntModule,
} from "../packages/app/src/module-lifecycle.js";

test("module registry validates descriptors and capabilities before startup", async () => {
  const registry = new ModuleRegistry();
  let started = false;
  registry.register({
    descriptor: moduleDescriptor("consumer", "frontend", [], ["missing"]),
    start() {
      started = true;
    },
  });
  await assert.rejects(registry.start(), /consumer requires missing capability missing/u);
  assert.equal(started, false);

  const incompatible = new ModuleRegistry();
  incompatible.register({
    descriptor: { ...moduleDescriptor("future", "runtime"), apiVersion: MODULE_API_VERSION + 1 },
  });
  await assert.rejects(incompatible.start(), /future uses unsupported API version/u);
});

test("module lifecycle starts in order and disposes in reverse on success", async () => {
  const calls: string[] = [];
  const registry = new ModuleRegistry();
  for (const id of ["one", "two"])
    registry.register({
      descriptor: moduleDescriptor(id, "infrastructure"),
      start() {
        calls.push(`start:${id}`);
      },
      dispose() {
        calls.push(`dispose:${id}`);
      },
      health: () => ({ status: "healthy" }),
    });
  await registry.run(async () => {
    calls.push("run");
  });
  assert.deepEqual(calls, ["start:one", "start:two", "run", "dispose:two", "dispose:one"]);
  const diagnostics = await registry.diagnostics();
  assert.ok(diagnostics.every((item) => item.state === "disposed"));
  assert.ok(diagnostics.every((item) => item.health?.status === "healthy"));
});

test("partial startup failure rolls back and preserves cleanup errors", async () => {
  const calls: string[] = [];
  const registry = new ModuleRegistry();
  const modules: AntModule[] = [
    {
      descriptor: moduleDescriptor("started", "infrastructure"),
      start() {
        calls.push("start");
      },
      dispose() {
        calls.push("dispose");
        throw new Error("cleanup");
      },
    },
    {
      descriptor: moduleDescriptor("failed", "infrastructure"),
      start() {
        throw new Error("startup");
      },
    },
  ];
  modules.forEach((item) => registry.register(item));
  await assert.rejects(registry.start(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /startup/u);
    assert.match(String(error.errors[1]), /cleanup/u);
    return true;
  });
  assert.deepEqual(calls, ["start", "dispose"]);
});

test("registry rejects duplicate ids, unknown kinds and late registration", async () => {
  const registry = new ModuleRegistry();
  registry.register({ descriptor: moduleDescriptor("one", "runtime") });
  assert.throws(
    () => registry.register({ descriptor: moduleDescriptor("one", "runtime") }),
    /Duplicate module/u,
  );
  await registry.start();
  assert.throws(
    () => registry.register({ descriptor: moduleDescriptor("late", "runtime") }),
    /after started/u,
  );
  await registry.dispose();

  const unknown = new ModuleRegistry();
  unknown.register({ descriptor: moduleDescriptor("unknown", "mystery") });
  await assert.rejects(unknown.start(), /unknown kind mystery/u);
});

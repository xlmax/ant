import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("session storage contract and adapters do not depend on runtime state", async () => {
  const files = await Promise.all(
    [
      "../packages/app/src/session.ts",
      "../packages/session-jsonl/src/jsonl-session-store.ts",
      "../packages/session-jsonl/src/memory-session-store.ts",
    ].map(async (path) => ({
      path,
      content: await readFile(new URL(path, import.meta.url), "utf8"),
    })),
  );

  for (const file of files) {
    assert.doesNotMatch(
      file.content,
      /AgentState|AgentEvent|AgentObserver|HistoryEvent/u,
      file.path,
    );
  }
  for (const file of files.filter(({ path }) => path.includes("/sessions/"))) {
    assert.doesNotMatch(file.content, /from\s+["'][^"']*\/core\//u, file.path);
  }
});

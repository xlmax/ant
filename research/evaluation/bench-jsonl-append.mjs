import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { stdout } from "node:process";

import { JsonlSessionStore } from "../../packages/session-jsonl/src/jsonl-session-store.ts";

const RECORD_COUNTS = [1_000, 5_000, 10_000, 20_000, 40_000];
const RUNS = 3;
const root = await mkdtemp(join(tmpdir(), "ant-jsonl-append-"));

try {
  stdout.write("records\tbytes\tappend-min-ms\tappend-runs-ms\n");
  for (const count of RECORD_COUNTS) {
    const store = new JsonlSessionStore(root);
    const session = await store.create({
      task: "JSONL append benchmark",
      payloads: Array.from({ length: count }, (_, index) => ({
        index,
        padding: "x".repeat(220),
      })),
    });
    const durations = [];
    for (let run = 0; run < RUNS; run += 1) {
      const startedAt = performance.now();
      await store.append(session.id, { benchmarkAppend: run });
      durations.push(performance.now() - startedAt);
    }
    const fileSize = (await stat(session.location)).size;
    stdout.write(
      `${[
        count,
        fileSize,
        Math.min(...durations).toFixed(3),
        durations.map((duration) => duration.toFixed(3)).join(","),
      ].join("\t")}\n`,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function sourceFiles(directory: URL): Promise<Array<{ path: string; content: string }>> {
  const root = fileURLToPath(directory);
  const names = (await readdir(root)).filter((name) => name.endsWith(".ts")).sort();
  return Promise.all(
    names.map(async (name) => ({
      path: name,
      content: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}

test("application contracts contain no DeepSeek-specific model policy", async () => {
  const files = await sourceFiles(new URL("../src/app/", import.meta.url));
  const leaks = files.filter((file) => /deepseek/iu.test(file.content));

  assert.deepEqual(
    leaks.map((file) => file.path),
    [],
  );
});

test("presentation adapters do not inspect opaque provider options", async () => {
  const files = await sourceFiles(new URL("../src/ui/", import.meta.url));
  const leaks = files.filter((file) => /providerOptions/u.test(file.content));

  assert.deepEqual(
    leaks.map((file) => file.path),
    [],
  );
});

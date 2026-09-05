import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveNpmInvocation } from "../packages/cli/src/npm-invocation.js";

test("npm invocation runs npm-cli.js through Node on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-npm-invocation-"));
  try {
    const node = join(root, "node.exe");
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(join(root, "node_modules", "npm", "bin"), { recursive: true });
    const yarnCli = join(root, "yarn.js");
    await Promise.all([writeFile(node, ""), writeFile(npmCli, ""), writeFile(yarnCli, "")]);

    assert.deepEqual(
      await resolveNpmInvocation({ PATH: "", npm_execpath: yarnCli }, "win32", node),
      {
        command: node,
        prefixArgs: ["--", npmCli],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm invocation uses the executable name on non-Windows platforms", async () => {
  assert.deepEqual(await resolveNpmInvocation({}, "linux", "/usr/bin/node"), {
    command: "npm",
    prefixArgs: [],
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("packed CLI installs in a clean project and loads the production composition", async () => {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "ant-packed-cli-"));
  const packDirectory = join(root, "pack");
  const installDirectory = join(root, "install");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Готово из пакета." } }] })}\n\ndata: [DONE]\n\n`,
    );
  });

  try {
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(join(home, ".ant"), { recursive: true }),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const packed = await exec(
      "npm",
      ["pack", "--workspace", "ant", "--pack-destination", packDirectory, "--silent"],
      { cwd: projectRoot },
    );
    assert.equal(packed.code, 0, packed.stderr);
    const [tarball] = await readdir(packDirectory);
    if (tarball === undefined || !tarball.endsWith(".tgz")) {
      throw new Error("npm pack did not create a tarball");
    }

    await writeFile(join(installDirectory, "package.json"), '{"private":true}', "utf8");
    const installed = await exec(
      "npm",
      ["install", "--ignore-scripts", join(packDirectory, tarball)],
      { cwd: installDirectory },
    );
    assert.equal(installed.code, 0, installed.stderr);

    await writeFile(
      join(home, ".ant", "settings.json"),
      JSON.stringify({
        model: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          thinking: { enabled: false },
        },
        ui: { color: false, showChanges: false, showReasoning: false },
      }),
      "utf8",
    );
    const binary = join(installDirectory, "node_modules", ".bin", "ant");
    const version = await exec(binary, ["--version"], { cwd: workspace });
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), "0.5.15");

    const run = await exec(binary, ["Проверь пакет"], {
      cwd: workspace,
      env: { HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: "packed-test-key" },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Готово из пакета\./u);
    const sessionFiles = await readdir(join(workspace, ".ant", "sessions"));
    const journal = sessionFiles.find((name) => name.endsWith(".jsonl"));
    assert.ok(journal);
    assert.match(
      await readFile(join(workspace, ".ant", "sessions", journal), "utf8"),
      /"schemaVersion":2/u,
    );
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

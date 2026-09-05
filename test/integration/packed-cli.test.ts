import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveNpmInvocation } from "../../packages/cli/src/npm-invocation.js";
import { VERSION } from "../../packages/contracts/src/version.js";

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
  const pluginSource = join(root, "reference-plugin");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify(
        requests === 1
          ? {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "plugin-call",
                        function: { name: "plugin_echo", arguments: '{"value":"ok"}' },
                      },
                    ],
                  },
                },
              ],
            }
          : { choices: [{ delta: { content: "Готово из пакета и плагина." } }] },
      )}\n\ndata: [DONE]\n\n`,
    );
  });

  try {
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(join(home, ".ant"), { recursive: true }),
      mkdir(pluginSource, { recursive: true }),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const npm = await resolveNpmInvocation();
    const packed = await exec(
      npm.command,
      [
        ...npm.prefixArgs,
        "pack",
        "--workspace",
        "ant",
        "--pack-destination",
        packDirectory,
        "--silent",
      ],
      { cwd: projectRoot },
    );
    assert.equal(packed.code, 0, packed.stderr);
    const [tarball] = await readdir(packDirectory);
    if (tarball === undefined || !tarball.endsWith(".tgz")) {
      throw new Error("npm pack did not create a tarball");
    }

    await writeFile(join(installDirectory, "package.json"), '{"private":true}', "utf8");
    const installed = await exec(
      npm.command,
      [
        ...npm.prefixArgs,
        "install",
        "--omit=optional",
        "--prefix",
        installDirectory,
        join(packDirectory, tarball),
      ],
      { cwd: installDirectory },
    );
    assert.equal(installed.code, 0, installed.stderr);

    const installedManifest = JSON.parse(
      await readFile(join(installDirectory, "node_modules", "ant", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    assert.equal(installedManifest.dependencies?.["win32-api"], undefined);
    assert.equal(installedManifest.optionalDependencies?.["win32-api"], "26.1.2");
    await assert.rejects(access(join(installDirectory, "node_modules", "win32-api")));
    await assert.rejects(access(join(installDirectory, "node_modules", "koffi")));
    assert.match(
      await readFile(join(installDirectory, "node_modules", "ant", "dist", "main.js"), "utf8"),
      /import\("win32-api"\)/u,
    );

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
    const binShim = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "ant.cmd" : "ant",
    );
    await access(binShim);
    const binary = join(installDirectory, "node_modules", "ant", "dist", "main.js");
    const version = await exec(process.execPath, [binary, "--version"], { cwd: workspace });
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), VERSION);

    await writeFile(
      join(pluginSource, "package.json"),
      JSON.stringify({ name: "ant-reference-plugin", version: "1.0.0" }),
    );
    await writeFile(
      join(pluginSource, "ant-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "reference.tools",
        version: "1.0.0",
        apiVersion: "^1.0.0",
        entry: "./index.mjs",
        permissions: [],
      }),
    );
    await writeFile(
      join(pluginSource, "index.mjs"),
      `export default {
        activate() {
          return { toolPacks: [{
            id: "reference.tools",
            create() { return [{
              metadata: { ownerId: "reference.tools", sideEffects: "none", parallelSafe: true, requiredCapabilities: [] },
              spec: { name: "plugin_echo", description: "Reference external plugin", inputSchema: { type: "object" } },
              async execute(input) { return { plugin: true, input }; }
            }]; }
          }] };
        }
      };\n`,
    );
    const pluginPack = await exec(
      npm.command,
      [...npm.prefixArgs, "pack", pluginSource, "--pack-destination", root, "--silent"],
      { cwd: root },
    );
    assert.equal(pluginPack.code, 0, pluginPack.stderr);
    const pluginTarball = join(root, pluginPack.stdout.trim());
    const pluginInstall = await exec(
      process.execPath,
      [binary, "plugins", "install", pluginTarball, "--trust"],
      {
        cwd: workspace,
        env: { HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(pluginInstall.code, 0, pluginInstall.stderr);
    assert.match(pluginInstall.stdout, /Installed reference\.tools 1\.0\.0/u);
    const pluginApi = await exec(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("ant/plugin-api").then((api) => console.log(api.PLUGIN_API_VERSION))',
      ],
      { cwd: installDirectory },
    );
    assert.equal(pluginApi.code, 0, pluginApi.stderr);
    assert.equal(pluginApi.stdout.trim(), "1.0.0");

    const run = await exec(process.execPath, [binary, "Проверь пакет"], {
      cwd: workspace,
      env: { HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: "packed-test-key" },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Готово из пакета и плагина\./u);
    assert.equal(requests, 2);
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

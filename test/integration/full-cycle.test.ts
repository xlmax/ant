import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface CapturedRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendEventStream(response: ServerResponse, payloads: readonly unknown[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

async function runCli(
  projectRoot: string,
  workspace: string,
  home: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(projectRoot, "src", "main.ts"), ...args],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DEEPSEEK_API_KEY: "integration-test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test("CLI completes a sandboxed task through DeepSeek, tools, and the session journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ant-full-cycle-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const requests: CapturedRequest[] = [];
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/chat/completions") {
        response.writeHead(404).end();
        return;
      }

      const body = await readRequestBody(request);
      requests.push({ authorization: request.headers.authorization, body });

      if (requests.length === 1) {
        sendEventStream(response, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-write",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          path: "hello.txt",
                          content: "Hello from Ant\n",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]);
        return;
      }

      sendEventStream(response, [
        {
          choices: [
            {
              delta: {
                content: requests.length === 2 ? "Файл создан." : `Продолжение ${requests.length}.`,
              },
            },
          ],
        },
      ]);
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mkdir(join(home, ".ant"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

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

    const result = await runCli(projectRoot, workspace, home, [
      "Создай hello.txt с текстом Hello from Ant",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Файл создан\./u);
    assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "Hello from Ant\n");

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.authorization, "Bearer integration-test-key");
    assert.equal(requests[1]?.authorization, "Bearer integration-test-key");
    assert.ok(Array.isArray(requests[0]?.body.tools));

    const secondMessages = requests[1]?.body.messages;
    assert.ok(Array.isArray(secondMessages));
    assert.ok(
      secondMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          message.role === "tool",
      ),
    );

    const sessionDirectory = join(workspace, ".ant", "sessions");
    const sessionFile = (await readdir(sessionDirectory)).find((name) => name.endsWith(".jsonl"));
    assert.ok(sessionFile);
    const sessionId = sessionFile.replace(/\.jsonl$/u, "");
    const resumed = await runCli(projectRoot, workspace, home, [
      "-s",
      sessionId,
      "Проверь результат",
    ]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /Продолжение 3\./u);

    const reopened = await runCli(projectRoot, workspace, home, ["-s", sessionId, "Подведи итог"]);
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.match(reopened.stdout, /Продолжение 4\./u);

    assert.equal(requests.length, 4);
    const resumedMessages = requests[3]?.body.messages;
    assert.ok(Array.isArray(resumedMessages));
    assert.ok(
      resumedMessages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "content" in message &&
          message.content === "Проверь результат",
      ),
    );

    const records = (await readFile(join(sessionDirectory, sessionFile), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            schemaVersion: number;
            payload: { schemaVersion: number; kind: string; event: { type: string } };
          },
      );
    assert.ok(records.every((record) => record.schemaVersion === 2));
    assert.ok(records.every((record) => record.payload.schemaVersion === 1));
    assert.ok(records.every((record) => record.payload.kind === "history-event"));
    assert.deepEqual(
      records.map((record) => record.payload.event.type),
      ["task", "decision", "observation", "decision", "user", "decision", "user", "decision"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

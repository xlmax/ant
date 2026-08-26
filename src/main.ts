#!/usr/bin/env node
import { join } from "node:path";

import { AntApplication } from "./app/application.js";
import { runCli } from "./cli/cli-adapter.js";
import { applyLocalEnvironment } from "./config/local-environment.js";
import { fileSettingsModule } from "./config/settings-module.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { defaultAgentRuntime } from "./core/default-runtime.js";
import { createDeepSeekProviderFromEnvironment } from "./models/deepseek-provider.js";
import { JsonlSessionStore } from "./sessions/jsonl-session-store.js";
import { createCodingTools } from "./tools/coding-tools.js";
import { ToolEnvironment } from "./tools/tool-environment.js";
import { TerminalFrontend } from "./ui/terminal-frontend.js";
import { VERSION } from "./version.js";

const application = new AntApplication({
  runtime: defaultAgentRuntime,
  settings: fileSettingsModule,
  loadSystemPrompt,
  createProvider: createDeepSeekProviderFromEnvironment,
  createSessionStore: (workspace) => new JsonlSessionStore(join(workspace, ".ant", "sessions")),
  createEnvironment: (workspace, options) =>
    new ToolEnvironment(
      createCodingTools(
        workspace,
        options.bashPath === undefined ? {} : { bashPath: options.bashPath },
      ),
    ),
  createFrontend: (options) => new TerminalFrontend(options),
});

runCli(
  { workspace: process.cwd(), args: process.argv.slice(2) },
  {
    application,
    version: VERSION,
    applyEnvironment: applyLocalEnvironment,
    output: {
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    },
  },
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

#!/usr/bin/env node
import { AntApplication } from "./app/application.js";
import { createCodingTools } from "./coding-tools.js";
import { applyLocalEnvironment } from "./config/local-environment.js";
import { fileSettingsModule } from "./config/settings-module.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { defaultAgentRuntime } from "./core/default-runtime.js";
import { ToolEnvironment } from "./core/environment.js";
import { JsonlSessionStore } from "./core/session-store.js";
import { createDeepSeekProviderFromEnvironment } from "./models/deepseek-provider.js";
import { TerminalFrontend } from "./ui/terminal-frontend.js";

const application = new AntApplication({
  runtime: defaultAgentRuntime,
  settings: fileSettingsModule,
  applyEnvironment: applyLocalEnvironment,
  loadSystemPrompt,
  createProvider: createDeepSeekProviderFromEnvironment,
  createSessionStore: (directory) => new JsonlSessionStore(directory),
  createEnvironment: (workspace, options) =>
    new ToolEnvironment(
      createCodingTools(
        workspace,
        options.bashPath === undefined ? {} : { bashPath: options.bashPath },
      ),
    ),
  createFrontend: (options) => new TerminalFrontend(options),
  output: {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  },
});

application
  .run({ workspace: process.cwd(), args: process.argv.slice(2) })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

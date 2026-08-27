#!/usr/bin/env node
import { join } from "node:path";

import {
  AntApplication,
  ConfigurationRegistry,
  ModuleRegistry,
  ToolRegistry,
  moduleDescriptor,
} from "@ant/app";
import { runCli } from "./cli-adapter.js";
import { applyLocalEnvironment } from "./config/local-environment.js";
import { registerBuiltinConfigurationSections } from "./config/builtin-configuration-sections.js";
import { createFileSettingsModule } from "./config/settings-module.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { VERSION } from "@ant/contracts";
import { defaultAgentRuntime } from "@ant/core";
import {
  ConsoleTerminal,
  ConsoleRenderer,
  TerminalFrontend,
  TurnRunner,
  configureAnsi,
  createBuiltinCommandRegistry,
  gitPresentationService,
  globalUpdateService,
  initConsoleSize,
  nodeProcessControl,
} from "@ant/frontend-terminal";
import {
  createDeepSeekProviderFromEnvironment,
  deepSeekConfigurationSection,
} from "@ant/provider-deepseek";
import { JsonlSessionStore } from "@ant/session-jsonl";
import { codingToolPack, ToolEnvironment } from "@ant/tools-coding";

const configurationRegistry = new ConfigurationRegistry();
configurationRegistry.register(deepSeekConfigurationSection);
registerBuiltinConfigurationSections(configurationRegistry);

const lifecycle = new ModuleRegistry();
for (const descriptor of [
  moduleDescriptor("ant.runtime.default", "runtime", ["agent.runtime"]),
  moduleDescriptor("ant.configuration.file", "configuration", ["configuration.sections"]),
  moduleDescriptor("ant.provider.deepseek", "model-provider", ["model.provider"]),
  moduleDescriptor("ant.session.jsonl", "session-store", ["session.store"]),
  moduleDescriptor("ant.tools.coding", "tool-pack", ["tools.coding"]),
  moduleDescriptor(
    "ant.frontend.terminal",
    "frontend",
    ["frontend"],
    ["agent.runtime", "model.provider", "session.store"],
  ),
])
  lifecycle.register({ descriptor });

const application = new AntApplication({
  lifecycle,
  runtime: defaultAgentRuntime,
  settings: createFileSettingsModule(configurationRegistry),
  loadSystemPrompt,
  createProvider: createDeepSeekProviderFromEnvironment,
  createSessionStore: (workspace) => new JsonlSessionStore(join(workspace, ".ant", "sessions")),
  createEnvironment: (workspace, options) => {
    const registry = new ToolRegistry();
    registry.register(codingToolPack);
    return new ToolEnvironment(
      registry.createTools({
        workspace,
        capabilities: new Set(["filesystem.read", "filesystem.write", "process.spawn"]),
        process: options.bashPath === undefined ? {} : { bashPath: options.bashPath },
        logger: { debug() {} },
      }),
    );
  },
  createFrontend: (options) =>
    new TerminalFrontend(options, {
      createTerminal: () => new ConsoleTerminal(),
      process: nodeProcessControl,
      updates: globalUpdateService,
      git: gitPresentationService,
      commands: createBuiltinCommandRegistry(),
      async initialize(color) {
        configureAnsi(color);
        await initConsoleSize();
      },
      createRenderer: () =>
        new ConsoleRenderer({
          reasoningMode: options.reasoningMode,
          reasoningMaxLines: options.reasoningMaxLines,
        }),
      createTurnRunner: (turnOptions) => new TurnRunner(turnOptions),
    }),
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

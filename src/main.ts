#!/usr/bin/env node
import { join } from "node:path";

import { AntApplication } from "./app/application.js";
import { ConfigurationRegistry } from "./app/configuration-registry.js";
import { ToolRegistry } from "./app/tool-registry.js";
import { ModuleRegistry, moduleDescriptor } from "./app/module-lifecycle.js";
import { runCli } from "./cli/cli-adapter.js";
import { applyLocalEnvironment } from "./config/local-environment.js";
import { registerBuiltinConfigurationSections } from "./config/builtin-configuration-sections.js";
import { createFileSettingsModule } from "./config/settings-module.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { defaultAgentRuntime } from "./core/default-runtime.js";
import { createDeepSeekProviderFromEnvironment } from "./models/deepseek-provider.js";
import { deepSeekConfigurationSection } from "./models/deepseek-configuration-section.js";
import { JsonlSessionStore } from "./sessions/jsonl-session-store.js";
import { codingToolPack } from "./tools/coding-tool-pack.js";
import { ToolEnvironment } from "./tools/tool-environment.js";
import { TerminalFrontend } from "./ui/terminal-frontend.js";
import { configureAnsi } from "./ui/ansi.js";
import { createBuiltinCommandRegistry } from "./ui/command-modules.js";
import { ConsoleRenderer } from "./ui/console-renderer.js";
import { initConsoleSize } from "./ui/console-size.js";
import {
  ConsoleTerminal,
  gitPresentationService,
  globalUpdateService,
  nodeProcessControl,
} from "./ui/terminal-adapters.js";
import { TurnRunner } from "./ui/turn-runner.js";
import { VERSION } from "./version.js";

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

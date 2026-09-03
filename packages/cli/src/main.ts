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
import { createBalanceCommand } from "./balance-command.js";
import { applyLocalEnvironment } from "./config/local-environment.js";
import { registerBuiltinConfigurationSections } from "./config/builtin-configuration-sections.js";
import { createFileSettingsModule } from "./config/settings-module.js";
import { loadSystemPrompt } from "./config/system-prompt.js";
import { FileCredentialStore } from "./credentials/credential-store.js";
import { DeepSeekCredentialManager } from "./credentials/deepseek-credentials.js";
import { createKeyCommand } from "./credentials/key-command.js";
import { defaultPluginRoot, handlePluginCommand } from "./plugins/plugin-cli.js";
import { loadInstalledPlugins, selectCompatibleToolPacks } from "./plugins/plugin-loader.js";
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
  DeepSeekAccountClient,
  DeepSeekProvider,
  deepSeekConfigurationSection,
} from "@ant/provider-deepseek";
import { JsonlSessionStore } from "@ant/session-jsonl";
import { codingToolPack, ToolEnvironment } from "@ant/tools-coding";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const output = {
    log: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
  };
  if (await handlePluginCommand(args, { output })) return;

  const workspace = process.cwd();
  const plugins = await loadInstalledPlugins({
    root: defaultPluginRoot(),
    workspace,
    logger: { info: output.log, warn: output.error },
  });
  for (const diagnostic of plugins.diagnostics) {
    output.error(
      `[plugin] ${diagnostic.id} ${diagnostic.version}: ${diagnostic.state} (${diagnostic.message})`,
    );
  }

  const terminal = new ConsoleTerminal();
  const credentials = new DeepSeekCredentialManager({
    store: new FileCredentialStore(),
    terminal,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });

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
    async createProvider({ systemPrompt }) {
      const credential = await credentials.resolve();
      return new DeepSeekProvider({ apiKey: credential.apiKey, systemPrompt });
    },
    createSessionStore: (root) => new JsonlSessionStore(join(root, ".ant", "sessions")),
    createEnvironment: (root, options) => {
      const context = {
        workspace: root,
        capabilities: new Set([
          "filesystem.read",
          "filesystem.write",
          "process.spawn",
          ...plugins.permissions,
        ]),
        process: options.bashPath === undefined ? {} : { bashPath: options.bashPath },
        logger: { debug() {} },
      };
      const accepted = selectCompatibleToolPacks(
        codingToolPack,
        plugins.toolPacks,
        context,
        (pack) => {
          output.error(`[plugin] ${pack.id}: tool pack validation failed`);
        },
      );
      const registry = new ToolRegistry();
      registry.register(codingToolPack);
      for (const pack of accepted) registry.register(pack);
      return new ToolEnvironment(registry.createTools(context));
    },
    createFrontend: (options) => {
      const commands = createBuiltinCommandRegistry();
      commands.register(createKeyCommand(credentials));
      commands.register(
        createBalanceCommand(async (signal) => {
          const credential = await credentials.resolve(signal);
          // Account balance is a DeepSeek-only endpoint. Deliberately avoid the
          // configurable model baseUrl so an API key is never sent to a model proxy.
          return new DeepSeekAccountClient({ apiKey: credential.apiKey }).getBalance(signal);
        }),
      );
      return new TerminalFrontend(options, {
        createTerminal: () => terminal,
        process: nodeProcessControl,
        updates: globalUpdateService,
        git: gitPresentationService,
        commands,
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
      });
    },
  });

  await runCli(
    { workspace, args },
    {
      application,
      version: VERSION,
      applyEnvironment: applyLocalEnvironment,
      output,
    },
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

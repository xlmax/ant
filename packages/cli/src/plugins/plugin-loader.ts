import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ToolRegistry, type ToolContext, type ToolPack } from "@ant/app";

import {
  PLUGIN_API_VERSION,
  validateExternalToolPack,
  type AntPlugin,
  type ExternalToolPack,
  type PluginLogger,
  type PluginPermission,
} from "../plugin-api.js";
import { parsePluginManifest } from "./manifest.js";
import { FilePluginRegistry } from "./plugin-registry.js";

export interface PluginDiagnostic {
  readonly id: string;
  readonly version: string;
  readonly state: "active" | "disabled" | "failed";
  readonly message: string;
}

export interface LoadedPlugins {
  readonly toolPacks: readonly ToolPack[];
  readonly diagnostics: readonly PluginDiagnostic[];
  readonly permissions: ReadonlySet<PluginPermission>;
}

export function selectCompatibleToolPacks(
  builtIn: ToolPack,
  external: readonly ToolPack[],
  context: ToolContext,
  onRejected: (pack: ToolPack) => void,
): readonly ToolPack[] {
  const accepted: ToolPack[] = [];
  for (const pack of external) {
    const candidate = new ToolRegistry();
    candidate.register(builtIn);
    for (const previous of accepted) candidate.register(previous);
    try {
      candidate.register(pack);
      candidate.createTools(context);
      accepted.push(pack);
    } catch {
      onRejected(pack);
    }
  }
  return accepted;
}

interface PluginModule {
  readonly default?: AntPlugin;
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function wrapToolPack(
  pluginId: string,
  pack: ExternalToolPack,
  workspace: string,
  approved: ReadonlySet<PluginPermission>,
  logger: PluginLogger,
): ToolPack {
  return {
    id: pack.id,
    create() {
      return validateExternalToolPack(pluginId, pack, {
        workspace,
        capabilities: approved,
        logger,
      });
    },
  };
}

export async function loadInstalledPlugins(options: {
  readonly root: string;
  readonly workspace: string;
  readonly logger: PluginLogger;
}): Promise<LoadedPlugins> {
  const registry = new FilePluginRegistry(options.root);
  const toolPacks: ToolPack[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const granted = new Set<PluginPermission>();

  for (const installed of await registry.list()) {
    if (!installed.enabled) {
      diagnostics.push({
        id: installed.id,
        version: installed.version,
        state: "disabled",
        message: "Plugin is disabled",
      });
      continue;
    }
    try {
      const pluginRoot = resolve(options.root, "packages", installed.id);
      const manifest = parsePluginManifest(
        JSON.parse(await readFile(join(pluginRoot, "ant-plugin.json"), "utf8")),
      );
      if (manifest.id !== installed.id || manifest.version !== installed.version) {
        throw new Error("Installed plugin does not match its registry record");
      }
      const approved = new Set(installed.approvedPermissions);
      if (manifest.permissions.some((permission) => !approved.has(permission))) {
        throw new Error("Plugin permissions are not approved");
      }
      const entry = resolve(pluginRoot, manifest.entry);
      const [canonicalRoot, canonicalEntry, entryStat] = await Promise.all([
        realpath(pluginRoot),
        realpath(entry),
        lstat(entry),
      ]);
      if (!within(canonicalRoot, canonicalEntry) || entryStat.isSymbolicLink()) {
        throw new Error("Plugin entry escapes its installed package");
      }
      const loaded = (await import(
        `${pathToFileURL(canonicalEntry).href}?antPlugin=${encodeURIComponent(manifest.version)}`
      )) as PluginModule;
      if (loaded.default === undefined || typeof loaded.default.activate !== "function") {
        throw new Error("Plugin entry must default-export an AntPlugin");
      }
      const activation = await loaded.default.activate(
        Object.freeze({
          apiVersion: PLUGIN_API_VERSION,
          workspace: options.workspace,
          permissions: approved,
          logger: options.logger,
        }),
      );
      for (const pack of activation.toolPacks ?? []) {
        toolPacks.push(
          wrapToolPack(manifest.id, pack, options.workspace, approved, options.logger),
        );
      }
      for (const permission of approved) granted.add(permission);
      diagnostics.push({
        id: manifest.id,
        version: manifest.version,
        state: "active",
        message: "Plugin activated",
      });
    } catch {
      options.logger.warn(`Plugin ${installed.id} failed to activate`);
      diagnostics.push({
        id: installed.id,
        version: installed.version,
        state: "failed",
        message: "Plugin activation failed",
      });
    }
  }

  return { toolPacks, diagnostics, permissions: granted };
}

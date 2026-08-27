export const PLUGIN_API_VERSION = "1.0.0";

export const PLUGIN_PERMISSIONS = [
  "filesystem.read",
  "filesystem.write",
  "process.spawn",
  "network",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface AntPluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly entry: string;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ExternalToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ExternalToolMetadata {
  readonly ownerId: string;
  readonly sideEffects: "none" | "workspace" | "process";
  readonly parallelSafe: boolean;
  readonly requiredCapabilities: readonly PluginPermission[];
}

export interface ExternalTool {
  readonly metadata: ExternalToolMetadata;
  readonly spec: ExternalToolSpec;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface ExternalToolContext {
  readonly workspace: string;
  readonly capabilities: ReadonlySet<PluginPermission>;
  readonly logger: PluginLogger;
}

export interface ExternalToolPack {
  readonly id: string;
  create(context: ExternalToolContext): readonly ExternalTool[];
}

export interface PluginActivationContext {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly workspace: string;
  readonly permissions: ReadonlySet<PluginPermission>;
  readonly logger: PluginLogger;
}

export interface PluginActivation {
  readonly toolPacks?: readonly ExternalToolPack[];
}

export interface AntPlugin {
  activate(context: PluginActivationContext): PluginActivation | Promise<PluginActivation>;
}

/** Reusable contract check for external tool packs and plugin author tests. */
export function validateExternalToolPack(
  pluginId: string,
  pack: ExternalToolPack,
  context: ExternalToolContext,
): readonly ExternalTool[] {
  if (pack.id !== pluginId && !pack.id.startsWith(`${pluginId}.`)) {
    throw new Error("External tool pack id must be owned by the plugin id");
  }
  const tools = pack.create(context);
  if (tools.length === 0) throw new Error(`External tool pack ${pack.id} is empty`);
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.metadata.ownerId !== pack.id) {
      throw new Error(`External tool ${tool.spec.name} has an invalid owner id`);
    }
    if (names.has(tool.spec.name)) {
      throw new Error(`External tool pack ${pack.id} repeats tool ${tool.spec.name}`);
    }
    names.add(tool.spec.name);
    for (const capability of tool.metadata.requiredCapabilities) {
      if (!context.capabilities.has(capability)) {
        throw new Error(`Plugin ${pluginId} attempted permission escalation`);
      }
    }
  }
  return tools;
}

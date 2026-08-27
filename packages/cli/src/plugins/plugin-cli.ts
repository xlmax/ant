import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { PLUGIN_PERMISSIONS, type PluginPermission } from "../plugin-api.js";
import { parsePluginManifest } from "./manifest.js";
import { PluginInstaller } from "./plugin-installer.js";
import { FilePluginRegistry } from "./plugin-registry.js";

export interface PluginCommandOutput {
  log(message: string): void;
  error(message: string): void;
}

export function defaultPluginRoot(): string {
  return join(homedir(), ".ant", "plugins");
}

function permissions(args: readonly string[]): PluginPermission[] {
  const values = args
    .filter((argument) => argument.startsWith("--allow="))
    .flatMap((argument) => argument.slice("--allow=".length).split(","))
    .filter(Boolean);
  const known = new Set<string>(PLUGIN_PERMISSIONS);
  for (const value of values) {
    if (!known.has(value)) throw new Error(`Unknown plugin permission: ${value}`);
  }
  return [...new Set(values)] as PluginPermission[];
}

function help(): string {
  return [
    "Plugin commands:",
    "  ant plugins list",
    "  ant plugins inspect <id>",
    "  ant plugins install <directory|tarball> --trust [--allow=a,b]",
    "  ant plugins enable <id>",
    "  ant plugins disable <id>",
    "  ant plugins remove <id>",
    "Plugins are trusted in-process code. Permissions are approvals, not a sandbox.",
  ].join("\n");
}

export async function handlePluginCommand(
  args: readonly string[],
  options: { readonly root?: string; readonly output: PluginCommandOutput },
): Promise<boolean> {
  if (args[0] !== "plugins") return false;
  const root = options.root ?? defaultPluginRoot();
  const registry = new FilePluginRegistry(root);
  const installer = new PluginInstaller(root);
  const command = args[1] ?? "help";
  const target = args[2];

  if (command === "help") {
    options.output.log(help());
    return true;
  }
  if (command === "list") {
    const installed = await registry.list();
    options.output.log(
      installed.length === 0
        ? "No plugins installed."
        : installed
            .map(
              (plugin) =>
                `${plugin.id} ${plugin.version} ${plugin.enabled ? "enabled" : "disabled"} [${plugin.approvedPermissions.join(", ")}]`,
            )
            .join("\n"),
    );
    return true;
  }
  if (target === undefined || target.startsWith("--")) {
    throw new Error(`plugins ${command} requires a target`);
  }
  if (command === "inspect") {
    const record = await registry.get(target);
    if (record === undefined) throw new Error(`Plugin is not installed: ${target}`);
    const manifest = parsePluginManifest(
      JSON.parse(await readFile(join(root, "packages", target, "ant-plugin.json"), "utf8")),
    );
    options.output.log(JSON.stringify({ ...record, manifest }, undefined, 2));
    return true;
  }
  if (command === "install") {
    if (!args.includes("--trust")) {
      throw new Error(
        "Plugin installation requires --trust because plugins execute as trusted in-process code",
      );
    }
    const installed = await installer.install(target, permissions(args.slice(3)));
    options.output.log(`Installed ${installed.id} ${installed.version}`);
    return true;
  }
  if (command === "enable" || command === "disable") {
    const updated = await installer.setEnabled(target, command === "enable");
    options.output.log(`${updated.id} is now ${updated.enabled ? "enabled" : "disabled"}`);
    return true;
  }
  if (command === "remove") {
    const trash = await installer.remove(target);
    options.output.log(`Removed ${target}; recoverable copy: ${trash}`);
    return true;
  }
  throw new Error(`Unknown plugin command: ${command}\n${help()}`);
}

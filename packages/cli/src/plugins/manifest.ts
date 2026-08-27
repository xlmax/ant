import { posix } from "node:path";

import {
  PLUGIN_API_VERSION,
  PLUGIN_PERMISSIONS,
  type AntPluginManifest,
  type PluginPermission,
} from "../plugin-api.js";

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const permissions = new Set<string>(PLUGIN_PERMISSIONS);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Plugin manifest must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function version(value: unknown, field: string): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`Plugin manifest ${field} must be a semantic version`);
  }
  return value;
}

function tuple(value: string): readonly [number, number, number] {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) throw new Error(`Invalid semantic version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function supportsPluginApi(range: string): boolean {
  const host = tuple(PLUGIN_API_VERSION);
  if (VERSION_PATTERN.test(range)) return compare(host, tuple(range)) === 0;
  if (range.startsWith("^")) {
    const minimum = tuple(range.slice(1));
    return host[0] === minimum[0] && compare(host, minimum) >= 0;
  }
  const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/u.exec(range);
  return (
    match !== null &&
    compare(host, tuple(match[1] ?? "")) >= 0 &&
    compare(host, tuple(match[2] ?? "")) < 0
  );
}

export function parsePluginManifest(value: unknown): AntPluginManifest {
  const input = record(value);
  if (input.schemaVersion !== 1) throw new Error("Plugin manifest schemaVersion must be 1");
  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    throw new Error("Plugin manifest id is invalid");
  }
  const pluginVersion = version(input.version, "version");
  if (typeof input.apiVersion !== "string" || !supportsPluginApi(input.apiVersion)) {
    throw new Error(`Plugin ${input.id} has an incompatible apiVersion`);
  }
  if (
    typeof input.entry !== "string" ||
    !input.entry.startsWith("./") ||
    input.entry.includes("\\")
  ) {
    throw new Error("Plugin manifest entry must be a relative ./ path");
  }
  const normalizedEntry = posix.normalize(input.entry);
  if (
    normalizedEntry.startsWith("../") ||
    normalizedEntry === ".." ||
    posix.isAbsolute(normalizedEntry)
  ) {
    throw new Error("Plugin manifest entry escapes the plugin root");
  }
  if (!Array.isArray(input.permissions)) {
    throw new Error("Plugin manifest permissions must be an array");
  }
  const requested = input.permissions.map((permission) => {
    if (typeof permission !== "string" || !permissions.has(permission)) {
      throw new Error(`Plugin ${input.id} requests an unknown permission`);
    }
    return permission as PluginPermission;
  });
  if (new Set(requested).size !== requested.length) {
    throw new Error(`Plugin ${input.id} repeats a permission`);
  }
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    version: pluginVersion,
    apiVersion: input.apiVersion,
    entry: normalizedEntry,
    permissions: Object.freeze(requested),
  });
}

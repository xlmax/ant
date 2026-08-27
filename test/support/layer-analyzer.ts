import { readdir, readFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";

import { parseModuleReferences, type ModuleReference } from "./import-graph.js";

const knownLayers = new Set([
  "app",
  "cli",
  "config",
  "core",
  "fs",
  "models",
  "sessions",
  "tools",
  "ui",
  "updates",
]);
const knownRootModules = new Set(["main.ts", "version.ts"]);

interface LayerRule {
  allowedLayers: ReadonlySet<string>;
  allowedRootModules?: ReadonlySet<string>;
  forbiddenModules?: ReadonlySet<string>;
  allowExternal: boolean;
}

const layerRules: Readonly<Record<string, LayerRule>> = {
  core: { allowedLayers: new Set(["core"]), allowExternal: false },
  app: { allowedLayers: new Set(["app", "core"]), allowExternal: false },
  cli: { allowedLayers: new Set(["cli", "app", "core"]), allowExternal: false },
  config: { allowedLayers: new Set(["config", "app", "fs"]), allowExternal: true },
  fs: { allowedLayers: new Set(["fs"]), allowExternal: true },
  models: { allowedLayers: new Set(["models", "app", "core"]), allowExternal: true },
  sessions: {
    allowedLayers: new Set(["sessions", "app", "core", "fs"]),
    allowExternal: true,
  },
  tools: { allowedLayers: new Set(["tools", "core", "fs"]), allowExternal: true },
  ui: {
    allowedLayers: new Set(["ui", "app", "core", "updates"]),
    allowedRootModules: new Set(["version.ts"]),
    forbiddenModules: new Set([
      "app/model-provider.ts",
      "app/session-controller.ts",
      "core/runtime.ts",
    ]),
    allowExternal: true,
  },
  updates: { allowedLayers: new Set(["updates"]), allowExternal: true },
};

interface SourceModule {
  absolutePath: string;
  path: string;
  references: ModuleReference[];
}

export interface ArchitectureViolation {
  kind: "cycle" | "dependency" | "opaque-import" | "unknown-module" | "unresolved-import";
  message: string;
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function sourcePath(sourceRoot: string, file: string): string {
  return relative(sourceRoot, file).split(sep).join("/");
}

function resolveSourceImport(
  sourceRoot: string,
  file: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
  return sourcePath(sourceRoot, target);
}

function resolveModulePath(modulePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return posix.normalize(posix.join(posix.dirname(modulePath), specifier.replace(/\.js$/u, ".ts")));
}

async function sourceModules(sourceRoot: string): Promise<SourceModule[]> {
  return Promise.all(
    (await typescriptFiles(sourceRoot)).map(async (absolutePath) => ({
      absolutePath,
      path: sourcePath(sourceRoot, absolutePath),
      references: parseModuleReferences(await readFile(absolutePath, "utf8"), absolutePath),
    })),
  );
}

function firstRuntimeCycle(modules: readonly SourceModule[]): string[] | undefined {
  const modulePaths = new Set(modules.map((module) => module.path));
  const edges = new Map(
    modules.map((module) => [
      module.path,
      module.references
        .filter((reference) => reference.runtime && reference.specifier !== undefined)
        .map((reference) => resolveModulePath(module.path, reference.specifier ?? ""))
        .filter((target): target is string => target !== undefined && modulePaths.has(target)),
    ]),
  );
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];

  const visit = (module: string): string[] | undefined => {
    const current = state.get(module);
    if (current === "active") {
      const cycleStart = stack.indexOf(module);
      return [...stack.slice(cycleStart), module];
    }
    if (current === "done") return undefined;

    state.set(module, "active");
    stack.push(module);
    for (const dependency of edges.get(module) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(module, "done");
    return undefined;
  };

  for (const module of modulePaths) {
    const cycle = visit(module);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/** Returns every statically detectable violation of the production layer policy. */
export async function analyzeLayerBoundaries(sourceRoot: string): Promise<ArchitectureViolation[]> {
  const violations: ArchitectureViolation[] = [];
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const known = entry.isDirectory()
      ? knownLayers.has(entry.name)
      : !entry.isFile() || !entry.name.endsWith(".ts") || knownRootModules.has(entry.name);
    if (!known) {
      violations.push({
        kind: "unknown-module",
        message: `Unknown production module or layer: ${entry.name}`,
      });
    }
  }

  const modules = await sourceModules(sourceRoot);
  const modulePaths = new Set(modules.map((module) => module.path));
  for (const module of modules) {
    const [layer] = module.path.split("/");
    if (layer === undefined || !knownLayers.has(layer)) continue;
    const rule = layerRules[layer];
    if (rule === undefined) {
      violations.push({ kind: "unknown-module", message: `Missing rule for ${layer}` });
      continue;
    }

    for (const reference of module.references) {
      if (reference.specifier === undefined) {
        violations.push({
          kind: "opaque-import",
          message: `${module.path} contains a non-literal module reference`,
        });
        continue;
      }

      const target = resolveSourceImport(sourceRoot, module.absolutePath, reference.specifier);
      if (target === undefined) {
        if (!rule.allowExternal) {
          violations.push({
            kind: "dependency",
            message: `${module.path} imports external module ${reference.specifier}`,
          });
        }
        continue;
      }
      if (!modulePaths.has(target)) {
        violations.push({
          kind: "unresolved-import",
          message: `${module.path} imports missing module ${target}`,
        });
        continue;
      }

      const [targetLayer] = target.split("/");
      const allowed =
        rule.forbiddenModules?.has(target) !== true &&
        ((targetLayer !== undefined && rule.allowedLayers.has(targetLayer)) ||
          rule.allowedRootModules?.has(target) === true);
      if (!allowed) {
        violations.push({
          kind: "dependency",
          message: `${module.path} imports forbidden dependency ${target}`,
        });
      }
    }
  }

  const cycle = firstRuntimeCycle(modules);
  if (cycle !== undefined) {
    violations.push({ kind: "cycle", message: cycle.join(" → ") });
  }
  return violations;
}

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { parseModuleReferences } from "./import-graph.js";

interface WorkspaceManifest {
  name?: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
}

export interface WorkspaceViolation {
  kind: "dependency" | "internal-import" | "manifest" | "missing-package";
  message: string;
}

const requiredPackages = [
  "contracts",
  "core",
  "app",
  "provider-deepseek",
  "session-jsonl",
  "tools-coding",
  "frontend-terminal",
  "cli",
] as const;

const allowedDependencies: Readonly<Record<string, ReadonlySet<string>>> = {
  "@ant/contracts": new Set(),
  "@ant/core": new Set(["@ant/contracts"]),
  "@ant/app": new Set(["@ant/contracts", "@ant/core"]),
  "@ant/provider-deepseek": new Set(["@ant/contracts", "@ant/core", "@ant/app"]),
  "@ant/session-jsonl": new Set(["@ant/contracts", "@ant/core", "@ant/app"]),
  "@ant/tools-coding": new Set(["@ant/contracts", "@ant/core", "@ant/app"]),
  "@ant/frontend-terminal": new Set(["@ant/contracts", "@ant/core", "@ant/app"]),
  ant: new Set([
    "@ant/contracts",
    "@ant/core",
    "@ant/app",
    "@ant/provider-deepseek",
    "@ant/session-jsonl",
    "@ant/tools-coding",
    "@ant/frontend-terminal",
  ]),
};

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

export async function analyzeWorkspaces(projectRoot: string): Promise<WorkspaceViolation[]> {
  const violations: WorkspaceViolation[] = [];
  const packagesRoot = resolve(projectRoot, "packages");
  const entries = new Set(await readdir(packagesRoot));

  for (const packageDirectory of requiredPackages) {
    if (!entries.has(packageDirectory)) {
      violations.push({
        kind: "missing-package",
        message: `Missing workspace package: ${packageDirectory}`,
      });
      continue;
    }

    const packageRoot = resolve(packagesRoot, packageDirectory);
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as WorkspaceManifest;
    const expectedName = packageDirectory === "cli" ? "ant" : `@ant/${packageDirectory}`;
    if (manifest.name !== expectedName || manifest.exports === undefined) {
      violations.push({
        kind: "manifest",
        message: `${packageDirectory} must be named ${expectedName} and declare exports`,
      });
    }

    const allowed = allowedDependencies[expectedName] ?? new Set<string>();
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith("@ant/"),
    )) {
      if (!allowed.has(dependency)) {
        violations.push({
          kind: "dependency",
          message: `${expectedName} depends on forbidden workspace ${dependency}`,
        });
      }
    }

    for (const file of await typescriptFiles(resolve(packageRoot, "src"))) {
      const source = await readFile(file, "utf8");
      for (const reference of parseModuleReferences(source, file)) {
        const specifier = reference.specifier;
        if (
          specifier?.includes("/src/") === true ||
          specifier?.includes("/dist/") === true ||
          specifier?.startsWith("../packages/") === true
        ) {
          violations.push({
            kind: "internal-import",
            message: `${file} bypasses package exports via ${specifier}`,
          });
        }
      }
    }
  }
  return violations;
}

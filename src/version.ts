import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// package.json always ships next to dist/ and next to src/ in development.
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
  version?: unknown;
};

if (typeof packageJson.version !== "string" || packageJson.version === "") {
  throw new Error("package.json does not contain a valid version");
}

export const VERSION = packageJson.version;

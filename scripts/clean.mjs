import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

rmSync("dist", { recursive: true, force: true });
for (const name of readdirSync("packages")) {
  rmSync(join("packages", name, "dist"), { recursive: true, force: true });
}

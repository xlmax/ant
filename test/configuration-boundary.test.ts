import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

test("filesystem configuration service is section-agnostic", async () => {
  const service = await readFile(
    source("packages/cli/src/config/configuration-service.ts"),
    "utf8",
  );
  for (const field of ["modelId", "baseUrl", "reasoningMode", "bashPath", "maxRounds"]) {
    assert.doesNotMatch(service, new RegExp(`\\b${field}\\b`, "u"));
  }
  assert.doesNotMatch(service, /deepseek/iu);
});

test("composition root registers configuration sections explicitly", async () => {
  const main = await readFile(source("packages/cli/src/main.ts"), "utf8");
  const applicationContract = await readFile(source("packages/app/src/configuration.ts"), "utf8");

  assert.match(main, /register\(deepSeekConfigurationSection\)/u);
  assert.match(main, /registerBuiltinConfigurationSections/u);
  assert.doesNotMatch(applicationContract, /interface AppSettings/u);
});

test("DeepSeek module owns model defaults, migration and secret policy", async () => {
  const section = await readFile(
    source("packages/provider-deepseek/src/deepseek-configuration-section.ts"),
    "utf8",
  );

  assert.match(section, /migrations/u);
  assert.match(section, /providerOptions\.baseUrl/u);
  assert.match(section, /providerOptions\.apiKey/u);
  assert.match(section, /DEEPSEEK|deepseek/iu);
});

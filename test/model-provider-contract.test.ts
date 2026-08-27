import assert from "node:assert/strict";
import test from "node:test";

import type { AgentModel } from "../src/core/agent.js";
import type { ContextSummarizer } from "../src/core/context-events.js";
import type {
  ModelConfiguration,
  ModelDescriptor,
  ModelProvider,
} from "../src/app/model-provider.js";
import { DeepSeekProvider } from "../src/models/deepseek-provider.js";

interface ProviderContractFixture {
  provider: ModelProvider;
  configuration: ModelConfiguration;
  alternativeModelId: string;
  reasoningSelection: string;
}

function runModelProviderContract(
  name: string,
  createFixture: () => ProviderContractFixture,
): void {
  test(`${name}: exposes a stable id and standard descriptor`, () => {
    const { provider, configuration } = createFixture();
    const descriptor = provider.describe(configuration);

    assert.equal(provider.id, configuration.providerId);
    assert.equal(descriptor.providerId, configuration.providerId);
    assert.equal(descriptor.modelId, configuration.modelId);
    assert.ok(descriptor.contextWindow > 0);
    assert.equal(typeof descriptor.capabilities.vision, "boolean");
    assert.equal(typeof descriptor.capabilities.reasoning.supported, "boolean");
    assert.ok(Array.isArray(descriptor.capabilities.reasoning.availableEfforts));
  });

  test(`${name}: creates model clients and lists models from opaque configuration`, async () => {
    const { provider, configuration } = createFixture();

    assert.ok(provider.createAgentModel(configuration));
    assert.ok(provider.createContextSummarizer(configuration));
    assert.ok((await provider.listModels(configuration)).length > 0);
  });

  test(`${name}: model selection is immutable and provider-owned`, () => {
    const { provider, configuration, alternativeModelId } = createFixture();
    const snapshot = structuredClone(configuration);

    const selected = provider.selectModel(configuration, alternativeModelId);

    assert.deepEqual(configuration, snapshot);
    assert.notEqual(selected, configuration);
    assert.equal(selected.providerId, provider.id);
    assert.equal(selected.modelId, alternativeModelId);
    assert.equal(provider.describe(selected).modelId, alternativeModelId);
  });

  test(`${name}: reasoning selection returns configuration and opaque persistence update`, () => {
    const { provider, configuration, reasoningSelection } = createFixture();
    const snapshot = structuredClone(configuration);

    const selected = provider.selectReasoning(configuration, reasoningSelection);

    assert.deepEqual(configuration, snapshot);
    assert.notEqual(selected.configuration, configuration);
    assert.equal(selected.configuration.providerId, provider.id);
    assert.notEqual(selected.settingsUpdate, undefined);
    assert.equal(
      provider.describe(selected.configuration).capabilities.reasoning.enabled,
      reasoningSelection !== "off",
    );
  });
}

function deepSeekConfiguration(modelId = "deepseek-v4-flash"): ModelConfiguration {
  return {
    providerId: "deepseek",
    modelId,
    providerOptions: {
      baseUrl: "https://api.deepseek.com",
      contextWindow: 1_000_000,
      thinking: { enabled: true, effort: "high" },
    },
  };
}

runModelProviderContract("DeepSeekProvider", () => ({
  provider: new DeepSeekProvider({
    apiKey: "test-key",
    systemPrompt: "system",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-vision" }] }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  }),
  configuration: deepSeekConfiguration(),
  alternativeModelId: "deepseek-vision",
  reasoningSelection: "max",
}));

test("DeepSeekProvider resolves capabilities and validates its own options", () => {
  const provider = new DeepSeekProvider({ apiKey: "test-key", systemPrompt: "system" });

  assert.equal(
    provider.describe(deepSeekConfiguration("deepseek-vision")).capabilities.vision,
    true,
  );
  assert.equal(
    provider.describe({
      ...deepSeekConfiguration("deepseek-vision"),
      providerOptions: {
        ...(deepSeekConfiguration().providerOptions as Record<string, unknown>),
        vision: false,
      },
    }).capabilities.vision,
    false,
  );
  assert.throws(
    () =>
      provider.describe({
        providerId: "deepseek",
        modelId: "model",
        providerOptions: { contextWindow: -1 },
      }),
    /contextWindow/u,
  );
  assert.throws(
    () => provider.selectReasoning(deepSeekConfiguration(), "extreme"),
    /reasoning effort/u,
  );
});

interface ReferenceOptions {
  window: number;
  images: boolean;
  depth: "off" | "brief" | "thorough";
}

function referenceOptions(configuration: ModelConfiguration): ReferenceOptions {
  return configuration.providerOptions as ReferenceOptions;
}

class ReferenceProvider implements ModelProvider {
  readonly id = "reference";

  describe(configuration: ModelConfiguration): ModelDescriptor {
    const options = referenceOptions(configuration);
    return {
      providerId: this.id,
      modelId: configuration.modelId,
      contextWindow: options.window,
      capabilities: {
        vision: options.images,
        reasoning: {
          supported: true,
          enabled: options.depth !== "off",
          ...(options.depth === "off" ? {} : { effort: options.depth }),
          availableEfforts: ["brief", "thorough"],
        },
      },
    };
  }

  createAgentModel(): AgentModel {
    return {
      async decide() {
        return { type: "finish", answer: "reference" };
      },
    };
  }

  createContextSummarizer(): ContextSummarizer {
    return {
      async summarize() {
        return "reference summary";
      },
    };
  }

  async listModels(): Promise<readonly string[]> {
    return ["reference-small", "reference-large"];
  }

  selectModel(configuration: ModelConfiguration, modelId: string): ModelConfiguration {
    return { ...configuration, modelId };
  }

  selectReasoning(configuration: ModelConfiguration, selection: string) {
    if (selection !== "off" && selection !== "brief" && selection !== "thorough") {
      throw new Error(`Unsupported reference reasoning effort: ${selection}`);
    }
    const options = referenceOptions(configuration);
    const providerOptions = { ...options, depth: selection } as ReferenceOptions;
    return {
      configuration: { ...configuration, providerOptions },
      settingsUpdate: { depth: selection },
    };
  }
}

runModelProviderContract("ReferenceProvider", () => ({
  provider: new ReferenceProvider(),
  configuration: {
    providerId: "reference",
    modelId: "reference-small",
    providerOptions: { window: 32_000, images: true, depth: "brief" } satisfies ReferenceOptions,
  },
  alternativeModelId: "reference-large",
  reasoningSelection: "thorough",
}));

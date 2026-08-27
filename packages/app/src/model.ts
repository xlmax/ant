/** Provider-neutral selection with adapter-owned opaque options. */
export interface ModelConfiguration {
  providerId: string;
  modelId: string;
  providerOptions: unknown;
}

export interface ReasoningCapability {
  supported: boolean;
  enabled: boolean;
  effort?: string;
  availableEfforts: readonly string[];
}

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  contextWindow: number;
  capabilities: {
    vision: boolean;
    reasoning: ReasoningCapability;
  };
}

export interface ModelConfigurationChange {
  configuration: ModelConfiguration;
  /** Opaque provider-owned update passed to configuration persistence. */
  settingsUpdate: unknown;
}

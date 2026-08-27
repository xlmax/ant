import type { ConfigurationKey, ConfigurationSection } from "./configuration-section.js";

export class ConfigurationRegistry {
  readonly #sections = new Map<string, ConfigurationSection<unknown, unknown>>();

  register<T, TPartial>(section: ConfigurationSection<T, TPartial>): void {
    const namespace = section.key.namespace.trim();
    if (namespace === "") throw new Error("Configuration namespace must not be empty");
    if (!Number.isInteger(section.version) || section.version < 1) {
      throw new Error(`Configuration section ${namespace} must have a positive version`);
    }
    if (this.#sections.has(namespace)) {
      throw new Error(`Duplicate configuration namespace: ${namespace}`);
    }
    this.#sections.set(namespace, section as ConfigurationSection<unknown, unknown>);
  }

  get<T>(key: ConfigurationKey<T>): ConfigurationSection<T, unknown> {
    const section = this.#sections.get(key.namespace);
    if (section === undefined) {
      throw new Error(`Unknown configuration namespace: ${key.namespace}`);
    }
    return section as ConfigurationSection<T, unknown>;
  }

  find(namespace: string): ConfigurationSection<unknown, unknown> | undefined {
    return this.#sections.get(namespace);
  }

  sections(): readonly ConfigurationSection<unknown, unknown>[] {
    return [...this.#sections.values()];
  }
}

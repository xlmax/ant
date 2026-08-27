export type ConfigurationLayer = "user" | "project";

export interface ConfigurationKey<T> {
  readonly namespace: string;
  /** Type marker only. */
  readonly _value?: T;
}

export function configurationKey<T>(namespace: string): ConfigurationKey<T> {
  return { namespace };
}

export interface ConfigurationContext {
  readonly source: string;
  readonly layer: ConfigurationLayer;
}

export interface ConfigurationSection<T, TPartial = unknown> {
  readonly key: ConfigurationKey<T>;
  readonly version: number;
  readonly defaults: T;
  readonly migrations: Readonly<Record<number, (value: unknown) => unknown>>;
  readonly sensitivePaths: readonly string[];
  readonly secretPaths: readonly string[];
  parse(value: unknown, context: ConfigurationContext): TPartial;
  merge(current: T, partial: TPartial, context: ConfigurationContext): T;
  serialize(value: T): unknown;
}

export interface ConfigurationSnapshot {
  readonly sources: readonly string[];
  get<T>(key: ConfigurationKey<T>): T;
  isProjectOverride<T>(key: ConfigurationKey<T>, path: string): boolean;
}

export const MODULE_API_VERSION = 1;

export type ModuleHealthStatus = "healthy" | "degraded" | "failed";

export interface ModuleDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly apiVersion: number;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
}

export interface ModuleHealth {
  readonly status: ModuleHealthStatus;
  readonly message?: string;
}

export interface AntModule {
  readonly descriptor: ModuleDescriptor;
  start?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
  health?(): Promise<ModuleHealth> | ModuleHealth;
}

export interface ModuleDiagnostic extends ModuleDescriptor {
  readonly state: "registered" | "started" | "disposed";
  readonly health?: ModuleHealth;
}

const MODULE_KINDS = new Set([
  "runtime",
  "configuration",
  "model-provider",
  "session-store",
  "tool-pack",
  "frontend",
  "infrastructure",
]);

export class ModuleRegistry {
  readonly #modules = new Map<string, AntModule>();
  readonly #started: AntModule[] = [];
  #state: "registering" | "started" | "disposed" = "registering";

  register(module: AntModule): void {
    if (this.#state !== "registering")
      throw new Error(`Cannot register module after ${this.#state}`);
    const { descriptor } = module;
    if (descriptor.id.trim() === "") throw new Error("Module id must not be empty");
    if (this.#modules.has(descriptor.id)) throw new Error(`Duplicate module: ${descriptor.id}`);
    this.#modules.set(descriptor.id, module);
  }

  validate(): void {
    if (this.#state !== "registering")
      throw new Error(`Cannot validate module host after ${this.#state}`);
    const capabilities = new Set<string>();
    for (const { descriptor } of this.#modules.values()) {
      if (!MODULE_KINDS.has(descriptor.kind))
        throw new Error(`Module ${descriptor.id} has unknown kind ${descriptor.kind}`);
      if (descriptor.apiVersion !== MODULE_API_VERSION)
        throw new Error(
          `Module ${descriptor.id} uses unsupported API version ${descriptor.apiVersion}`,
        );
      for (const capability of descriptor.provides) capabilities.add(capability);
    }
    for (const { descriptor } of this.#modules.values()) {
      for (const requirement of descriptor.requires) {
        if (!capabilities.has(requirement))
          throw new Error(`Module ${descriptor.id} requires missing capability ${requirement}`);
      }
    }
  }

  async start(): Promise<void> {
    this.validate();
    try {
      for (const module of this.#modules.values()) {
        await module.start?.();
        this.#started.push(module);
      }
      this.#state = "started";
    } catch (error) {
      const cleanupErrors = await this.#disposeStarted();
      this.#state = "disposed";
      if (cleanupErrors.length > 0)
        throw new AggregateError([error, ...cleanupErrors], "Module startup and cleanup failed", {
          cause: error,
        });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#state === "disposed") return;
    if (this.#state !== "started") throw new Error("Cannot dispose modules before start");
    const errors = await this.#disposeStarted();
    this.#state = "disposed";
    if (errors.length > 0) throw new AggregateError(errors, "Module cleanup failed");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.start();
    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      await this.dispose();
    } catch (cleanupError) {
      if (operationError !== undefined)
        throw new AggregateError(
          [operationError, cleanupError],
          "Application and module cleanup failed",
          { cause: cleanupError },
        );
      throw cleanupError;
    }
    if (operationError !== undefined) throw operationError;
    return value as T;
  }

  async diagnostics(): Promise<readonly ModuleDiagnostic[]> {
    return Promise.all(
      [...this.#modules.values()].map(async (module) => ({
        ...module.descriptor,
        state: this.#started.includes(module)
          ? ("started" as const)
          : this.#state === "disposed"
            ? ("disposed" as const)
            : ("registered" as const),
        ...(module.health === undefined ? {} : { health: await module.health() }),
      })),
    );
  }

  async #disposeStarted(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const module of [...this.#started].reverse()) {
      try {
        await module.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#started.length = 0;
    return errors;
  }
}

export function moduleDescriptor(
  id: string,
  kind: string,
  provides: readonly string[] = [],
  requires: readonly string[] = [],
): ModuleDescriptor {
  return { id, kind, apiVersion: MODULE_API_VERSION, provides, requires };
}

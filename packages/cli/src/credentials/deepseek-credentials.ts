import type { TerminalPort } from "@ant/frontend-terminal";
import { CredentialStoreError, FileCredentialStore } from "./credential-store.js";

export type DeepSeekCredentialSource = "environment" | "credentials" | "session";

export interface ResolvedDeepSeekCredential {
  apiKey: string;
  source: DeepSeekCredentialSource;
}

export interface DeepSeekCredentialManagerOptions {
  store: FileCredentialStore;
  terminal: TerminalPort;
  interactive: boolean;
  environment?: NodeJS.ProcessEnv;
}

export class DeepSeekCredentialManager {
  readonly #store: FileCredentialStore;
  readonly #terminal: TerminalPort;
  readonly #interactive: boolean;
  readonly #environment: NodeJS.ProcessEnv;
  #sessionCredential: ResolvedDeepSeekCredential | undefined;

  constructor(options: DeepSeekCredentialManagerOptions) {
    this.#store = options.store;
    this.#terminal = options.terminal;
    this.#interactive = options.interactive;
    this.#environment = options.environment ?? process.env;
  }

  #environmentKey(): string | undefined {
    const key = this.#environment.DEEPSEEK_API_KEY?.trim();
    return key === "" ? undefined : key;
  }

  async resolve(signal?: AbortSignal): Promise<ResolvedDeepSeekCredential> {
    const environmentKey = this.#environmentKey();
    if (environmentKey) return { apiKey: environmentKey, source: "environment" };

    try {
      const storedKey = await this.#store.readDeepSeekKey();
      if (storedKey) return { apiKey: storedKey, source: "credentials" };
    } catch (error) {
      if (!this.#interactive) throw this.#nonInteractiveError(error);
      this.#terminal.error(this.#storeErrorMessage(error));
      if (error instanceof CredentialStoreError && error.kind === "corrupt") {
        this.#terminal.warn(
          "The damaged credentials file will not be changed without confirmation.",
        );
      }
    }

    if (!this.#interactive) throw this.#nonInteractiveError();
    return this.#onboard(signal);
  }

  async status(): Promise<DeepSeekCredentialSource | undefined> {
    if (this.#environmentKey()) return "environment";
    try {
      if (await this.#store.readDeepSeekKey()) return "credentials";
    } catch (error) {
      throw new Error(this.#storeErrorMessage(error), { cause: error });
    }
    return this.#sessionCredential?.source;
  }

  async promptAndSave(signal?: AbortSignal): Promise<"saved" | "cancelled"> {
    if (!this.#interactive) throw this.#nonInteractiveError();
    const apiKey = await this.#terminal.readSecret("API key:\n> ", signal);
    if (apiKey === undefined) return "cancelled";
    if (apiKey.trim() === "") throw new Error("API key must not be empty.");
    await this.#store.writeDeepSeekKey(apiKey);
    this.#sessionCredential = { apiKey: apiKey.trim(), source: "credentials" };
    return "saved";
  }

  async clearStored(): Promise<boolean> {
    return this.#store.clearDeepSeekKey();
  }

  hasEnvironmentKey(): boolean {
    return this.#environmentKey() !== undefined;
  }

  async #onboard(signal?: AbortSignal): Promise<ResolvedDeepSeekCredential> {
    this.#terminal.log("DeepSeek API key is not configured.");
    let apiKey: string | undefined;
    while (!apiKey) {
      const entered = await this.#terminal.readSecret("\nAPI key:\n> ", signal);
      if (entered === undefined) throw new Error("DeepSeek API key entry was cancelled.");
      apiKey = entered.trim();
      if (!apiKey) this.#terminal.error("API key must not be empty.");
    }

    let save: boolean;
    while (true) {
      let answer: boolean | undefined;
      try {
        answer = await this.#terminal.confirm("Save for future sessions? [Y/n] ", signal);
      } catch (error) {
        this.#terminal.error(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (answer === undefined) throw new Error("DeepSeek API key entry was cancelled.");
      save = answer;
      break;
    }

    if (save) {
      try {
        await this.#store.writeDeepSeekKey(apiKey);
        this.#sessionCredential = { apiKey, source: "credentials" };
        return this.#sessionCredential;
      } catch (error) {
        this.#terminal.error(this.#storeErrorMessage(error));
        this.#terminal.warn("The API key will be used only for this process.");
      }
    }

    this.#sessionCredential = { apiKey, source: "session" };
    return this.#sessionCredential;
  }

  #nonInteractiveError(cause?: unknown): Error {
    return new Error(
      "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY for non-interactive use.",
      cause === undefined ? undefined : { cause },
    );
  }

  #storeErrorMessage(error: unknown): string {
    if (error instanceof CredentialStoreError) return error.message;
    return "Unable to access ANT credentials file.";
  }
}

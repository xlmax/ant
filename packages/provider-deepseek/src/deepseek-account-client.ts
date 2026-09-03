const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepSeekBalance {
  available: boolean;
  balances: readonly DeepSeekBalanceInfo[];
}

export interface DeepSeekAccountClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function errorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return requiredString(payload.error.message);
}

function parseBalance(payload: unknown): DeepSeekBalance {
  if (!isRecord(payload) || typeof payload.is_available !== "boolean") {
    throw new Error("DeepSeek returned an invalid balance response");
  }
  if (!Array.isArray(payload.balance_infos)) {
    throw new Error("DeepSeek returned an invalid balance response");
  }

  const balances = payload.balance_infos.map((value) => {
    if (!isRecord(value)) throw new Error("DeepSeek returned an invalid balance response");
    const currency = requiredString(value.currency);
    const totalBalance = requiredString(value.total_balance);
    const grantedBalance = requiredString(value.granted_balance);
    const toppedUpBalance = requiredString(value.topped_up_balance);
    if (!currency || !totalBalance || !grantedBalance || !toppedUpBalance) {
      throw new Error("DeepSeek returned an invalid balance response");
    }
    return { currency, totalBalance, grantedBalance, toppedUpBalance };
  });

  return { available: payload.is_available, balances };
}

/** DeepSeek account API client kept separate from model-completion traffic. */
export class DeepSeekAccountClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekAccountClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === "") throw new Error("DeepSeek API key must not be empty");
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/$/u, "");
    if (baseUrl === "") throw new Error("DeepSeek baseUrl must not be empty");
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getBalance(signal?: AbortSignal): Promise<DeepSeekBalance> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/user/balance`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Сетевая ошибка: ${error.message}`, { cause: error });
      }
      throw error;
    }

    if (!response.ok) {
      let detail: string | undefined;
      try {
        detail = errorMessage(JSON.parse(await response.text()));
      } catch {
        // The HTTP status remains actionable when the API does not return JSON.
      }
      const safeDetail = detail?.replaceAll(this.#apiKey, "[redacted]").slice(0, 300);
      throw new Error(
        `DeepSeek balance API returned ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new Error("DeepSeek returned invalid JSON for balance");
    }
    return parseBalance(payload);
  }
}

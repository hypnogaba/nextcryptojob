import type { Network } from "@x402/core/types";

/**
 * Налаштування x402 з оточення Worker (специфікація CRM, розділ 7.3).
 *
 * Функція чиста: оточення приходить аргументом, тож її легко перевірити
 * тестом і викликати з маршруту REST, MCP чи cron однаково.
 *
 * Правила «без ключів» (contracts §8, специфікація 7.3):
 * - продакшн без CDP_API_KEY_ID/CDP_API_KEY_SECRET або без адрес отримувача:
 *   x402 вимкнено, причина називає, чого бракує ("not configured: CDP_API_KEY_ID");
 * - розробка без ключів CDP: тестові мережі через https://x402.org/facilitator.
 * Адреси отримувача потрібні завжди: гроші без адреси піти не можуть, а
 * підставна адреса в розробці тихо «з'їдала» б тестові платежі.
 */

export const PAID_ACTIONS = ["search_candidates", "request_intro", "buy_usdc_month"] as const;
export type PaidAction = (typeof PAID_ACTIONS)[number];

/** Ціни в атомарних одиницях USDC (6 знаків після коми). Однакові для Base і Solana. */
export const PRICES: Readonly<Record<PaidAction, { readonly amount: string; readonly usdCents: number }>> = {
  search_candidates: { amount: "500000", usdCents: 50 },
  request_intro: { amount: "5000000", usdCents: 500 },
  buy_usdc_month: { amount: "100000000", usdCents: 10000 },
};

export type X402Mode = "mainnet" | "testnet";

/** Значення збігаються з CHECK колонки x402_payments.facilitator (0004_billing). */
export type FacilitatorKind = "cdp" | "x402org";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
export const X402ORG_FACILITATOR_URL = "https://x402.org/facilitator";

/** Одна мережа, якою приймаємо оплату: CAIP-2, USDC цієї мережі, отримувач. */
export interface X402Network {
  readonly network: Network;
  readonly family: "evm" | "svm";
  /** Адреса контракту (EVM) або mint (Solana) USDC. */
  readonly asset: string;
  readonly payTo: string;
  /** EVM: домен EIP-712 контракту USDC ({ name, version }). Solana: порожньо, feePayer дає фасилітатор. */
  readonly extra: Readonly<Record<string, string>>;
}

export interface FacilitatorSettings {
  readonly kind: FacilitatorKind;
  readonly url: string;
  /** Лише для CDP. Секрет не перелічується, тож JSON.stringify і console.log його не покажуть. */
  readonly auth?: { readonly apiKeyId: string; readonly apiKeySecret: string };
}

export type X402Config =
  | {
      readonly enabled: true;
      readonly mode: X402Mode;
      readonly networks: readonly X402Network[];
      readonly facilitator: FacilitatorSettings;
    }
  | {
      readonly enabled: false;
      /** Текст для людини й для помилки API `not_configured`, без секретів. */
      readonly reason: string;
      /** Назви змінних, яких бракує або які задано хибно. */
      readonly missing: readonly string[];
      readonly networks: readonly [];
      readonly facilitator: null;
    };

/** Змінні, які читає x402. Секрети Worker і звичайні змінні приходять однаково. */
export interface X402Env {
  X402_NETWORK?: string;
  X402_PAY_TO_EVM?: string;
  X402_PAY_TO_SOLANA?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}

/** USDC за специфікацією 7.3; ці рядки і є договір, а не значення з бібліотеки. */
const USDC: Record<X402Mode, { evm: Omit<X402Network, "payTo">; svm: Omit<X402Network, "payTo"> }> = {
  mainnet: {
    evm: {
      network: "eip155:8453",
      family: "evm",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: "USD Coin", version: "2" },
    },
    svm: {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      family: "svm",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      extra: {},
    },
  },
  testnet: {
    evm: {
      network: "eip155:84532",
      family: "evm",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: { name: "USDC", version: "2" },
    },
    svm: {
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      family: "svm",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      extra: {},
    },
  },
};

// contracts.md §10 називає мережі 'base'|'solana'|'base-sepolia'|'solana-devnet',
// специфікація 7.3 каже mainnet|testnet. Приймаємо обидва написання.
const MODE_ALIASES: Record<string, X402Mode> = {
  mainnet: "mainnet",
  base: "mainnet",
  solana: "mainnet",
  testnet: "testnet",
  "base-sepolia": "testnet",
  "solana-devnet": "testnet",
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

let warnedTestnetInProduction = false;

/** Для тестів: попередження про тестову мережу в продакшні знову спрацює. */
export function resetConfigWarnings(): void {
  warnedTestnetInProduction = false;
}

function disabled(reason: string, missing: string[]): X402Config {
  return { enabled: false, reason, missing, networks: [], facilitator: null };
}

/**
 * Збирає налаштування x402.
 *
 * @param env оточення Worker (або його частина з X402Env)
 * @param nodeEnv NODE_ENV; у збірці Next воно вшите як "production"
 */
export function readX402Config(env: X402Env, nodeEnv: string | undefined = process.env.NODE_ENV): X402Config {
  const production = nodeEnv === "production";

  const rawMode = clean(env.X402_NETWORK)?.toLowerCase();
  const mode: X402Mode | undefined = rawMode === undefined ? (production ? "mainnet" : "testnet") : MODE_ALIASES[rawMode];
  if (!mode) {
    return disabled(`invalid setting: X402_NETWORK must be mainnet or testnet, got "${rawMode}"`, ["X402_NETWORK"]);
  }

  const apiKeyId = clean(env.CDP_API_KEY_ID);
  const apiKeySecret = clean(env.CDP_API_KEY_SECRET);
  const hasCdp = apiKeyId !== undefined && apiKeySecret !== undefined;
  const payToEvm = clean(env.X402_PAY_TO_EVM);
  const payToSolana = clean(env.X402_PAY_TO_SOLANA);

  const missing: string[] = [];
  // x402.org обслуговує лише тестові мережі, тож без CDP живуть тільки розробка й testnet.
  if (!hasCdp && (production || mode === "mainnet")) {
    if (!apiKeyId) missing.push("CDP_API_KEY_ID");
    if (!apiKeySecret) missing.push("CDP_API_KEY_SECRET");
  }
  if (!payToEvm) missing.push("X402_PAY_TO_EVM");
  if (!payToSolana) missing.push("X402_PAY_TO_SOLANA");
  if (missing.length > 0) return disabled(`not configured: ${missing.join(", ")}`, missing);

  // Помилка в адресі отримувача відправила б гроші в нікуди: краще вимкнути x402.
  const invalid: string[] = [];
  if (!EVM_ADDRESS.test(payToEvm!)) invalid.push("X402_PAY_TO_EVM");
  if (!SOLANA_ADDRESS.test(payToSolana!)) invalid.push("X402_PAY_TO_SOLANA");
  if (invalid.length > 0) {
    return disabled(`invalid setting: ${invalid.join(", ")} is not a valid address`, invalid);
  }

  const assets = USDC[mode];
  const networks: X402Network[] = [
    { ...assets.evm, payTo: payToEvm! },
    { ...assets.svm, payTo: payToSolana! },
  ];

  let facilitator: FacilitatorSettings;
  if (hasCdp) {
    facilitator = { kind: "cdp", url: CDP_FACILITATOR_URL };
    Object.defineProperty(facilitator, "auth", {
      value: Object.freeze({ apiKeyId, apiKeySecret }),
      enumerable: false,
    });
  } else {
    facilitator = { kind: "x402org", url: X402ORG_FACILITATOR_URL };
  }

  if (production && mode === "testnet" && !warnedTestnetInProduction) {
    // Не помилка (так перевіряють прод на тестових грошах), але забути цей стан не можна.
    warnedTestnetInProduction = true;
    console.warn(
      "x402: PRODUCTION IS RUNNING ON TEST NETWORKS (X402_NETWORK=testnet). Payments are test USDC, not real money.",
    );
  }

  return { enabled: true, mode, networks, facilitator };
}

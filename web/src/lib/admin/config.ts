import { ATS_WINDOW_DAYS, LIVE_WINDOW_DAYS, POSTED_WINDOW_DAYS, SCAN_TIME_UTC, STALE_AFTER_SCANS } from "@/lib/admin/job-sources";
import { adminEmails } from "@/lib/auth/admin";
import { CODE_TTL_MINUTES, MIN_SECRET_LENGTH } from "@/lib/auth/email-code";
import { SESSION_DAYS } from "@/lib/auth/session";
import { TRIAL_DAYS } from "@/lib/billing/checkout";
import { stripeSettings, type StripeEnv } from "@/lib/billing/stripe";
import { CRON_BUDGET_MS, SCHEDULE } from "@/lib/cron";
import { QUOTA_NAMES, quotaLimit, SEATS, type QuotaName, type QuotaPlan } from "@/lib/crm/quotas";
import { DEFAULT_SITE_URL, siteOrigin } from "@/lib/site";
import { PRICES, readX402Config, type X402Env } from "@/lib/x402/config";

/**
 * Налаштування лише для читання на /admin/settings: те, що міняється деплоєм або
 * секретом Worker, і числа з коду. Значень секретів не показуємо ніколи, лише «є / немає».
 * Ключі рушія живуть на VPS (/etc/nextcryptojob-engine.env): web їх не бачить, лише
 * прогалини `not configured: <KEY>`, які рушій пише в source_facts (ENGINE_KEYS_SQL).
 */

export type ConfigItem = {
  name: string;
  /** set / missing для секретів; value для несекретних значень. */
  state: "set" | "missing" | "value";
  value?: string;
  note?: string;
  /**
   * Що означає «немає» (власник 17.09: «тут не зрозуміло, скажи, що від мене»):
   * needed = сайт без цього не працює як слід, це треба поставити;
   * optional = працює й без цього, просто гірше;
   * unused = можливість вимкнена свідомо, ставити нічого не треба.
   * Типово needed.
   */
  need?: "needed" | "optional" | "unused";
};

export type ConfigGroup = { title: string; status?: { ok: boolean; text: string }; items: ConfigItem[] };

type Env = Record<string, unknown>;

function present(env: Env, name: string): boolean {
  const v = env[name];
  if (typeof v === "string") return v.trim().length > 0;
  return v !== undefined && v !== null;
}

function secret(env: Env, name: string, note?: string, need: ConfigItem["need"] = "needed"): ConfigItem {
  return { name, state: present(env, name) ? "set" : "missing", note, need };
}

/** Групи змінних Worker для сторінки налаштувань. */
export function workerConfig(env: Env, nodeEnv: string | undefined = process.env.NODE_ENV): ConfigGroup[] {
  const rawAdmins = typeof env.ADMIN_EMAILS === "string" ? env.ADMIN_EMAILS : undefined;
  const admins = adminEmails(rawAdmins);
  const rawSite = typeof env.SITE_URL === "string" ? env.SITE_URL.trim() : "";
  const session = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  const stripe = stripeSettings(env as unknown as StripeEnv);
  const x402 = readX402Config(env as X402Env, nodeEnv);
  const network = typeof env.X402_NETWORK === "string" && env.X402_NETWORK.trim() ? env.X402_NETWORK.trim() : null;

  return [
    {
      title: "Access and site",
      items: [
        {
          name: "ADMIN_EMAILS",
          state: "value",
          value: admins.join(", "),
          note: rawAdmins?.trim() ? "Admins sign in by email code." : "Not set: only the owner is admin.",
        },
        {
          name: "SITE_URL",
          state: "value",
          value: siteOrigin({ SITE_URL: rawSite }),
          note: rawSite ? "Links in emails use this address." : `Not set: links use ${DEFAULT_SITE_URL}.`,
        },
      ],
    },
    {
      title: "Sign-in and mail",
      items: [
        {
          name: "SESSION_SECRET",
          state: session ? "set" : "missing",
          note: session && session.length < MIN_SECRET_LENGTH ? `Shorter than ${MIN_SECRET_LENGTH} characters: email sign-in is off.` : "Email sign-in codes.",
        },
        {
          name: "EMAIL",
          state: present(env, "EMAIL") ? "set" : "missing",
          note: "Cloudflare Email Service binding: sign-in codes and digest emails.",
        },
        secret(env, "TELEGRAM_OIDC_CLIENT_ID", "Telegram sign-in button."),
        secret(env, "TELEGRAM_OIDC_CLIENT_SECRET"),
        secret(env, "TELEGRAM_BOT_TOKEN", "Bot messages and intro notices."),
        secret(env, "TELEGRAM_WEBHOOK_SECRET"),
      ],
    },
    {
      title: "Payments",
      status: stripe.enabled
        ? { ok: true, text: "Card payments on" }
        : { ok: true, text: "Card payments off. Companies pay by hand or in USDC; set these three only if you want card checkout." },
      items: [
        secret(env, "STRIPE_SECRET_KEY", "From the Stripe dashboard.", "unused"),
        secret(env, "STRIPE_PRICE_ID", "The monthly price you created in Stripe.", "unused"),
        secret(env, "STRIPE_WEBHOOK_SECRET", "From the Stripe webhook endpoint.", "unused"),
      ],
    },
    {
      title: "x402 (USDC)",
      status: x402.enabled
        ? { ok: true, text: `x402 on, ${x402.mode}, facilitator ${x402.facilitator.kind}` }
        : { ok: true, text: "Pay per request in USDC is off. Set these only if you want agents and companies to pay per call." },
      items: [
        { name: "X402_NETWORK", state: "value", value: network ?? "not set", note: network ? undefined : "Default: mainnet in production, testnet elsewhere." },
        secret(env, "X402_PAY_TO_EVM", "Your receiving address on Base.", "unused"),
        secret(env, "X402_PAY_TO_SOLANA", "Your receiving address on Solana.", "unused"),
        secret(env, "CDP_API_KEY_ID", "Coinbase Developer Platform key, to check payments.", "unused"),
        secret(env, "CDP_API_KEY_SECRET", "The secret of the same key.", "unused"),
      ],
    },
    {
      title: "Integrations",
      items: [
        secret(env, "WEBHOOK_SIGNING_KEY", "Company webhooks. Never change it after launch (docs/ops.md)."),
        secret(env, "INTERNAL_API_SECRET", "Digest emails from the engine."),
        secret(env, "TWITTER_TOKEN", "X checks in onboarding."),
        secret(env, "GITHUB_TOKEN", "GitHub checks work without it, just 60 an hour instead of 5000.", "optional"),
      ],
    },
  ];
}

/** Ключі рушія (docs/contracts.md §6 і §8). */
export const ENGINE_KEYS = ["TWITTER_TOKEN", "ETHERSCAN_KEY", "BLOCKSCOUT_KEY", "HELIUS_KEY", "YOUTUBE_KEY", "GITHUB_TOKEN"] as const;
export type EngineKey = (typeof ENGINE_KEYS)[number];

/**
 * Одна інструкція: скільки фактів джерел мають прогалину `not configured: <KEY>` і коли
 * востаннє, на кожен ключ. Лише числа й час, без самих прогалин (у часткових є початок
 * адреси гаманця). Прохід по source_facts лише на сторінці налаштувань.
 */
export const ENGINE_KEYS_SQL = `SELECT ${ENGINE_KEYS.map(
  (k) =>
    `COALESCE(SUM(gap_reason LIKE '%not configured: ${k}%'), 0) AS ${k}, ` +
    `MAX(CASE WHEN gap_reason LIKE '%not configured: ${k}%' THEN fetched_at END) AS ${k}_at`,
).join(",\n       ")}
  FROM source_facts WHERE gap_reason LIKE '%not configured:%'`;

export type EngineKeyReport = { key: EngineKey; missingIn: number; lastSeen: string | null };

export async function engineKeyReport(db: D1Database): Promise<EngineKeyReport[]> {
  const row = (await db.prepare(ENGINE_KEYS_SQL).first<Record<string, number | string | null>>()) ?? {};
  return ENGINE_KEYS.map((key) => ({
    key,
    missingIn: Number(row[key] ?? 0) || 0,
    lastSeen: typeof row[`${key}_at`] === "string" ? (row[`${key}_at`] as string) : null,
  }));
}

/** Числа з коду: змінюються правкою й деплоєм. */
export type CodeTable = { title: string; where: string; head: string[]; rows: (string | number)[][]; numeric?: boolean };

const PLAN_LABELS: Record<QuotaPlan, string> = {
  subscription: "Subscription",
  trial: "Trial",
  pay_per_request: "Pay per request",
  guest: "x402 guest",
};

const QUOTA_LABELS: Record<QuotaName, string> = {
  search_candidates: "Searches / day",
  get_candidate: "Profile views / day",
  request_intro_day: "Intros / day",
  request_intro_month: "Intros / month",
};

function limitText(n: number | null): string {
  if (n === null) return "no limit";
  return n === 0 ? "not included" : String(n);
}

export function codeTables(): CodeTable[] {
  const plans: QuotaPlan[] = ["subscription", "trial", "pay_per_request", "guest"];
  const seatPlans = ["subscription", "trial", "pay_per_request"] as const;
  const cronRows = Object.entries(SCHEDULE).map(([cron, jobs]) => [
    cron,
    jobs.map((j) => j.name).join(", "),
    `${Math.round((CRON_BUDGET_MS[cron] ?? 60_000) / 1000)} s`,
  ]);
  return [
    {
      title: "Quotas",
      where: "web/src/lib/crm/quotas.ts",
      numeric: true,
      head: ["Plan", ...QUOTA_NAMES.map((q) => QUOTA_LABELS[q])],
      rows: plans.map((p) => [PLAN_LABELS[p], ...QUOTA_NAMES.map((q) => limitText(quotaLimit(p, q)))]),
    },
    {
      title: "Seats",
      where: "web/src/lib/crm/quotas.ts",
      numeric: true,
      head: ["Plan", "Saved searches", "Open jobs", "Members", "API keys"],
      rows: seatPlans.map((p) => [PLAN_LABELS[p], SEATS[p].savedSearches, SEATS[p].openJobs, SEATS[p].members, SEATS[p].apiKeys]),
    },
    {
      title: "Trial and prices",
      where: "web/src/lib/billing/checkout.ts, web/src/lib/x402/config.ts",
      head: ["Setting", "Value"],
      rows: [
        ["Company trial", `${TRIAL_DAYS} days (also stated on /company)`],
        ["x402 candidate search page", `$${(PRICES.search_candidates.usdCents / 100).toFixed(2)}`],
        ["x402 intro request", `$${(PRICES.request_intro.usdCents / 100).toFixed(2)}`],
        ["x402 USDC month", `$${(PRICES.buy_usdc_month.usdCents / 100).toFixed(2)}`],
      ],
    },
    {
      title: "Sign-in and digests",
      where: "web/src/lib/auth, engine/src/digest",
      head: ["Setting", "Value"],
      rows: [
        ["Session length", `${SESSION_DAYS} days`],
        ["Email code lifetime", `${CODE_TTL_MINUTES} min`],
        ["Digest", "Up to 5 jobs, hourly engine run at :05, at each person's hour"],
        ["Live job window", `In the latest scan of its source (${LIVE_WINDOW_DAYS} days if the source fails); posted in ` +
          `${ATS_WINDOW_DAYS} days on an employer ATS, ${POSTED_WINDOW_DAYS} days on a board`],
        ["Job scanner", `Daily at ${SCAN_TIME_UTC} (engine jobs-scan, jobs DB nextcryptojob-jobs)`],
        ["Stale source", `Not in the last ${STALE_AFTER_SCANS} scans`],
      ],
    },
    {
      title: "Cron",
      where: "web/wrangler.jsonc, web/src/lib/cron/index.ts",
      head: ["Schedule", "Jobs", "Time budget"],
      rows: cronRows,
    },
  ];
}

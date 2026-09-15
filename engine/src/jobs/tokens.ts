// Токен роботодавця з CoinGecko (db/jobs/0004_company_token.sql): для рядка «$ARB $0.42 · MC $1.9B · +3.1%»
// поруч із вакансією на /jobs, у листі, у Telegram і в search_jobs.
//
// Зіставлення (`jobs-tokens`, щотижня після jobs-discover і jobs-about):
// 1. Пари, задані руками (token-overrides.ts), без мережі: вони переважують усе, зокрема «токена немає».
// 2. Решта компаній з доменом, яких ще не перевіряли (або «не знайдено» давніше за TOKENS_RECHECK_DAYS):
//    - один запит /coins/list (усі монети: id, тікер, назва) і збіг назв локально: назва компанії й назва
//      монети без загальних слів («Uniswap Labs» = «Uniswap», «Polygon Labs» = «Polygon Ecosystem Token»).
//      Пошук /search тут не годиться: «Uniswap Labs» він не знаходить зовсім (перевірено 14.09.2026);
//    - один пакетний /coins/markets на всіх кандидатів: живі монети за капіталізацією, мертві відпадають;
//    - до MAX_CANDIDATES запитів /coins/{id} на компанію, від найбільшої: монета годиться, лише коли її
//      links.homepage веде на домен компанії (той самий зареєстрований домен або відомий псевдонім) і вона
//      не стейблкоїн, не обгортка й не токен стейкінгу. Без домену нічого не вгадується.
// Ціни (щодня після jobs-scan і наприкінці jobs-tokens): один запит /simple/price на кожні PRICE_BATCH
// зіставлених монет. Збій лишає попередні значення і ніколи не валить скан; сайт ховає рядок через 3 доби.
//
// Ліміт: публічний API без ключа пропускав 5 до 7 запитів на хвилину (14.09.2026, далі 429 з
// Retry-After 60), тож бюджет CoinGecko 1 запит на 13 с (limits.ts), а з COINGECKO_API_KEY (демо-ключ,
// 30 на хвилину) 1 на 2,5 с; ключ іде заголовком x-cg-demo-api-key і ніде не друкується. Стеля
// JOBS_TOKENS_BUDGET запитів за прогін: решта компаній чекає наступного тижня.
import { companyKey } from "../digest/clean.js";
import { fetchJson, type FetchOptions, SourceUnavailableError } from "../http.js";
import { COINGECKO, COINGECKO_KEY_INTERVAL_MS, configureBudget } from "../limits.js";
import type { EngineEnv } from "../pipeline/registry.js";
import { envInt } from "./env.js";
import type { JobsStore, TokenConfidence, TokenMapping, TokenPrice, TokenRow } from "./store.js";
import { TOKEN_OVERRIDES, type TokenOverride } from "./token-overrides.js";

export const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
export const COINGECKO_KEY_ENV = "COINGECKO_API_KEY";
/** Запитів до CoinGecko на зіставлення за прогін найбільше (без цін). Без ключа це ≈ 13 хвилин. */
export const TOKENS_CALL_BUDGET = 60;
/** «Не знайдено» перевіряємо знову через стільки днів: монета могла з'явитись. */
export const TOKENS_RECHECK_DAYS = 28;
/** Скільки монет-кандидатів на компанію перевіряти запитом /coins/{id} найбільше. */
export const MAX_CANDIDATES = 3;
/** Монет в одному запиті /simple/price і /coins/markets. */
export const PRICE_BATCH = 100;

const DAY_MS = 86_400_000;
const COIN_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// ---------------- CoinGecko ----------------

export interface CoinListItem { id: string; symbol: string; name: string }
export interface CoinMarket { id: string; symbol?: string; name?: string; market_cap?: number | null }
export interface CoinDetail { id?: string; symbol?: string; name?: string; categories?: unknown; links?: { homepage?: unknown } }
type SimplePrice = Record<string, { usd?: unknown; usd_market_cap?: unknown; usd_24h_change?: unknown; last_updated_at?: unknown }>;

/** Бюджет запитів прогону вичерпано: решта чекає наступного разу. */
export class BudgetExhaustedError extends Error {
  override name = "BudgetExhaustedError";
}

/**
 * Клієнт CoinGecko з лічильником запитів. Кожен запит бере слот бюджету api.coingecko.com (limits.ts);
 * 429 відсуває весь бюджет на Retry-After (до 60 с) і повторюється один раз, далі SourceUnavailableError 429.
 */
export class CoinGecko {
  calls = 0;

  constructor(private readonly key: string | null, private readonly o: FetchOptions = {}, private readonly budget = Infinity) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    if (this.calls >= this.budget) throw new BudgetExhaustedError(`CoinGecko budget of ${this.budget} calls used`);
    this.calls++;
    const u = new URL(`${COINGECKO_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const init: RequestInit = this.key ? { headers: { "x-cg-demo-api-key": this.key } } : {};
    return fetchJson<T>(u.toString(), init, { retries: 1, retryDelayMs: 2_000, timeoutMs: 30_000, ...this.o });
  }

  async coinsList(): Promise<CoinListItem[]> {
    const list = await this.get<unknown>("/coins/list", {});
    if (!Array.isArray(list)) throw new SourceUnavailableError("CoinGecko /coins/list: not a list");
    return list.filter((c): c is CoinListItem => !!c && typeof c === "object" && typeof (c as CoinListItem).id === "string"
      && typeof (c as CoinListItem).name === "string" && typeof (c as CoinListItem).symbol === "string");
  }

  /** Живі монети з капіталізацією, пакетами по PRICE_BATCH. Монети, яких CoinGecko не знає, відсутні. */
  async markets(ids: readonly string[]): Promise<Map<string, CoinMarket>> {
    const out = new Map<string, CoinMarket>();
    for (let i = 0; i < ids.length; i += PRICE_BATCH) {
      const part = ids.slice(i, i + PRICE_BATCH);
      const rows = await this.get<unknown>("/coins/markets", { vs_currency: "usd", ids: part.join(","), per_page: "250", page: "1" });
      if (!Array.isArray(rows)) throw new SourceUnavailableError("CoinGecko /coins/markets: not a list");
      for (const r of rows as CoinMarket[]) if (r && typeof r.id === "string") out.set(r.id, r);
    }
    return out;
  }

  async coin(id: string): Promise<CoinDetail> {
    if (!COIN_ID.test(id)) throw new SourceUnavailableError(`CoinGecko: odd coin id ${id.slice(0, 40)}`);
    return this.get<CoinDetail>(`/coins/${encodeURIComponent(id)}`, {
      localization: "false", tickers: "false", market_data: "false", community_data: "false", developer_data: "false", sparkline: "false",
    });
  }

  async simplePrice(ids: readonly string[]): Promise<SimplePrice> {
    return this.get<SimplePrice>("/simple/price", {
      ids: ids.join(","), vs_currencies: "usd", include_market_cap: "true", include_24hr_change: "true", include_last_updated_at: "true",
    });
  }
}

/** Клієнт з оточення: ключ (якщо є) і бюджет запитів; з ключем швидший темп бюджету CoinGecko. */
export function coinGeckoFromEnv(env: EngineEnv, o: FetchOptions = {}, budget = Infinity): CoinGecko {
  const key = env[COINGECKO_KEY_ENV]?.trim() || null;
  if (key) configureBudget(COINGECKO, { concurrency: 1, minIntervalMs: COINGECKO_KEY_INTERVAL_MS });
  return new CoinGecko(key, o, budget);
}

// ---------------- назви й домени ----------------

/** Слова, що не відрізняють компанію від її монети: «Uniswap Labs» і «Uniswap», «Pyth Network» і «Pyth». */
const GENERIC_WORDS = new Set([
  "labs", "lab", "foundation", "protocol", "network", "networks", "dao", "finance", "exchange", "technologies", "technology",
  "tech", "group", "holdings", "global", "association", "systems", "studios", "studio", "trading", "markets", "company",
  "the", "io", "xyz", "official", "token", "coin", "ecosystem", "hq", "development", "developers", "app",
]);

/**
 * Варіанти назви для збігу: companyKey назви поза дужками і (для компанії) в дужках, кожен ще й без
 * загальних слів. «Axiom (axiom.xyz)» → axiom, axiom xyz; «Polygon Ecosystem Token» → polygon ecosystem
 * token, polygon. Монеті дужки не беремо: «Uniswap (Wormhole)» це міст Uniswap, а не монета Wormhole.
 */
export function nameCores(name: string, withInner = true): string[] {
  const out = new Set<string>();
  const inner = withInner ? [...name.matchAll(/\(([^)]*)\)/g)].map((m) => m[1] ?? "") : [];
  for (const part of [name.replace(/\([^)]*\)/g, " "), ...inner]) {
    const key = companyKey(part);
    if (!key) continue;
    out.add(key);
    const core = key.split(" ").filter((w) => w && !GENERIC_WORDS.has(w));
    if (core.length) out.add(core.join(" "));
  }
  return [...out].filter((v) => v.replace(/ /g, "").length >= 2);
}

/** Хост адреси без www; null для не-http(s) і кривих адрес. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/** Зареєстрований домен: два останні ярлики, три для «co.uk», «com.au» тощо. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  if (labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/**
 * Хости, де сайт має будь-хто (піддомен або сторінка): збіг зареєстрованого домену тут нічого не доводить.
 * Компанія з таким доменом не підтверджується ніколи.
 */
const SHARED_SITES = new Set([
  "github.io", "github.com", "gitbook.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com",
  "notion.site", "notion.so", "webflow.io", "framer.website", "framer.ai", "wixsite.com", "carrd.co", "linktr.ee", "medium.com",
  "substack.com", "mirror.xyz", "paragraph.xyz", "blogspot.com", "wordpress.com", "super.site", "typedream.app", "x.com",
  "twitter.com", "t.me", "discord.gg", "discord.com", "google.com", "youtube.com", "linkedin.com", "coingecko.com", "coinmarketcap.com",
]);

/** Домени, які одна організація вживає поруч (з token-overrides.ts: усі домени одного запису). */
export function domainAliases(domain: string, overrides: readonly TokenOverride[] = TOKEN_OVERRIDES): string[] {
  const d = domain.toLowerCase();
  const reg = registrableDomain(d);
  const group = overrides.find((o) => o.domains?.some((x) => x === d || registrableDomain(x) === reg));
  return group?.domains?.filter((x) => registrableDomain(x) !== reg) ?? [];
}

/**
 * Чи веде хоч одна адреса links.homepage монети на домен компанії: той самий зареєстрований домен
 * (stake.lido.fi і lido.fi) або псевдонім. Для спільних хостів (github.io, medium.com…) ні.
 */
export function homepageConfirms(domain: string, homepages: unknown, aliases: readonly string[] = []): boolean {
  const own = hostOf(domain);
  if (!own || SHARED_SITES.has(registrableDomain(own))) return false;
  const regs = new Set([own, ...aliases.map(hostOf).filter((h): h is string => !!h)].map(registrableDomain)
    .filter((r) => !SHARED_SITES.has(r)));
  const list = Array.isArray(homepages) ? homepages : [];
  return list.some((u) => {
    const h = hostOf(u);
    return !!h && regs.has(registrableDomain(h));
  });
}

/** Стейблкоїни, обгортки, токени стейкінгу й токенізовані активи: це не токен компанії. */
const NOT_COMPANY_TOKEN = /(^|\s)stablecoins?$|^wrapped-tokens$|^bridged-tokens$|^bridged stablecoins$|liquid (re)?staking tokens$|^tokenized /i;

export function isCompanyToken(detail: CoinDetail): boolean {
  const cats = Array.isArray(detail.categories) ? detail.categories.filter((c): c is string => typeof c === "string") : [];
  return !cats.some((c) => NOT_COMPANY_TOKEN.test(c.trim()));
}

/**
 * Запис token-overrides.ts для компанії: за companyKey повної назви або за доменом. Лише повна назва:
 * «Wormhole (Asymmetric)» не те саме, що «Wormhole».
 */
export function overrideFor(name: string, domain: string | null, overrides: readonly TokenOverride[] = TOKEN_OVERRIDES): TokenOverride | null {
  const key = companyKey(name);
  const d = domain?.trim().toLowerCase().replace(/^www\./, "") || null;
  return overrides.find((o) => (key !== "" && o.names.includes(key)) || (d !== null && !!o.domains?.includes(d))) ?? null;
}

/** Покажчик назва → id монет (лише назви; тікер надто часто збігається випадково). */
export function coinIndex(list: readonly CoinListItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of list) {
    if (!COIN_ID.test(c.id)) continue;
    for (const v of nameCores(c.name, false)) {
      const ids = out.get(v);
      if (!ids) out.set(v, [c.id]);
      else if (!ids.includes(c.id)) ids.push(c.id);
    }
  }
  return out;
}

/** Монети-кандидати компанії: збіг варіантів назви і першого ярлика домену («lido.fi» → lido). */
export function candidatesFor(name: string, domain: string, index: ReadonlyMap<string, readonly string[]>): string[] {
  const variants = new Set(nameCores(name));
  const label = registrableDomain(domain).split(".")[0] ?? "";
  if (label.length >= 3) variants.add(label);
  const out: string[] = [];
  for (const v of variants) for (const id of index.get(v) ?? []) if (!out.includes(id)) out.push(id);
  return out;
}

// ---------------- зіставлення ----------------

export interface TokensDeps {
  store: JobsStore;
  env: EngineEnv;
  log?: (line: string) => void;
  fetch?: FetchOptions;
  now?: Date;
  /** Домени, які щойно знайшов би jobs-about (сухий прогін): поверх companies.domain. */
  domains?: ReadonlyMap<string, string>;
  /** false: без цін наприкінці. */
  prices?: boolean;
  overrides?: readonly TokenOverride[];
}

export interface TokenMatch { slug: string; name: string; domain: string | null; coingeckoId: string; symbol: string; confidence: TokenConfidence }

export interface TokensReport {
  dry: boolean;
  /** Стовпців 0004 ще немає: нічого не зроблено. */
  skipped: string | null;
  companies: number;
  withDomain: number;
  /** Компаній зі зіставленою монетою після прогону (руками + доменом), з них нових цього прогону. */
  mapped: number;
  matches: TokenMatch[];
  overrides: { companies: number; noToken: number; changed: number; unknownIds: string[] };
  /** Скільки компаній пошук мав перевірити, скільки мали кандидатів, скільки підтверджено й не знайдено. */
  due: number;
  withCandidates: number;
  confirmed: number;
  notFound: number;
  /** Не перевірено через бюджет чи 429: наступного разу. */
  deferred: number;
  failed: number;
  rateLimited: boolean;
  calls: number;
  budget: number;
  mappings: TokenMapping[];
  prices: PricesReport | null;
  rowsWritten: { estimated: number; measured: number | null };
}

const isRateLimit = (e: unknown): boolean => e instanceof SourceUnavailableError && e.status === 429;
// Без параметрів адреси: довгий ?ids=… з'їдав 160 символів разом із кодом відповіді, а ключ може бути в параметрах.
const shortMsg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1").slice(0, 160);

/** Чи треба компанію шукати цього разу: без зіставлення або «не знайдено» давніше за TOKENS_RECHECK_DAYS. */
export function isDue(row: TokenRow, now: Date): boolean {
  if (row.token_confidence === "homepage") return false;
  if (row.token_confidence !== "none") return true; // null або колишнє 'override', якого вже немає в файлі
  const at = Date.parse(row.token_checked_at ?? "");
  return !Number.isFinite(at) || now.getTime() - at >= TOKENS_RECHECK_DAYS * DAY_MS;
}

/**
 * Зіставити компанії з монетами CoinGecko і (типово) оновити ціни. Кожна компанія окремо: збій одного
 * запиту лишає її до наступного разу; 429 після повтору чи вичерпаний бюджет зупиняють пошук, і вже
 * знайдене записується.
 */
export async function runCompanyTokens(deps: TokensDeps): Promise<TokensReport> {
  const { store, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const overrides = deps.overrides ?? TOKEN_OVERRIDES;
  const budget = envInt(env, "JOBS_TOKENS_BUDGET", TOKENS_CALL_BUDGET, 0, 5000);
  const report: TokensReport = {
    dry: store.dry, skipped: null, companies: 0, withDomain: 0, mapped: 0, matches: [],
    overrides: { companies: 0, noToken: 0, changed: 0, unknownIds: [] }, due: 0, withCandidates: 0, confirmed: 0, notFound: 0,
    deferred: 0, failed: 0, rateLimited: false, calls: 0, budget, mappings: [], prices: null, rowsWritten: { estimated: 0, measured: null },
  };

  const rows = await store.loadTokenRows();
  if (!rows) {
    report.skipped = "companies token columns missing";
    log("jobs-tokens: companies.coingecko_id missing (apply db/jobs/0004_company_token.sql first), nothing done");
    return report;
  }
  report.companies = rows.length;
  const domainOf = (r: TokenRow): string | null => r.domain ?? deps.domains?.get(r.slug) ?? null;
  report.withDomain = rows.filter((r) => domainOf(r)).length;
  const mappings = new Map<string, TokenMapping>();
  const matched = new Map<string, TokenMatch>();

  // 1. Пари, задані руками: без мережі.
  const searchable: TokenRow[] = [];
  for (const row of rows) {
    const ov = overrideFor(row.name, domainOf(row), overrides);
    if (!ov) { searchable.push(row); continue; }
    report.overrides.companies++;
    if (!ov.coingeckoId) report.overrides.noToken++;
    else matched.set(row.slug, { slug: row.slug, name: row.name, domain: domainOf(row), coingeckoId: ov.coingeckoId, symbol: ov.symbol ?? "", confidence: "override" });
    if (row.coingecko_id !== ov.coingeckoId || row.token_symbol !== ov.symbol || row.token_confidence !== "override") {
      report.overrides.changed++;
      mappings.set(row.slug, { slug: row.slug, coingeckoId: ov.coingeckoId, symbol: ov.symbol, confidence: "override", checkedAt: at,
        clearPrice: row.coingecko_id !== ov.coingeckoId });
    }
  }
  for (const row of searchable) {
    if (row.token_confidence === "homepage" && row.coingecko_id && row.token_symbol) {
      matched.set(row.slug, { slug: row.slug, name: row.name, domain: domainOf(row), coingeckoId: row.coingecko_id, symbol: row.token_symbol, confidence: "homepage" });
    }
  }

  // 2. Пошук: компанії з доменом, яких пора перевірити; спершу ніколи не перевірені, далі найдавніші.
  const due = searchable.filter((r) => domainOf(r) && isDue(r, now)).sort((a, b) =>
    (Number(b.enabled) - Number(a.enabled)) || ((a.token_checked_at ?? "") < (b.token_checked_at ?? "") ? -1 : 1) || (a.slug < b.slug ? -1 : 1));
  report.due = due.length;
  const overrideIds = [...new Set(overrides.map((o) => o.coingeckoId).filter((id): id is string => !!id))];
  const cg = coinGeckoFromEnv(env, deps.fetch ?? {}, budget);

  if (budget > 0 && (due.length > 0 || overrideIds.length > 0)) {
    try {
      const index = due.length > 0 ? coinIndex(await cg.coinsList()) : new Map<string, string[]>();
      const cands = new Map<string, string[]>();
      for (const row of due) {
        const c = candidatesFor(row.name, domainOf(row)!, index);
        if (c.length) cands.set(row.slug, c);
      }
      report.withCandidates = cands.size;
      // Один пакет на всіх кандидатів і на пари руками (чи CoinGecko ще знає ці id).
      const allIds = [...new Set([...overrideIds, ...[...cands.values()].flat()])];
      let markets: Map<string, CoinMarket> | null = null;
      try {
        markets = await cg.markets(allIds);
        report.overrides.unknownIds = overrideIds.filter((id) => !markets!.has(id));
      } catch (e) {
        if (e instanceof BudgetExhaustedError || isRateLimit(e)) throw e;
        log(`jobs-tokens: /coins/markets did not answer (${shortMsg(e)}), candidates go unranked`);
      }
      const details = new Map<string, CoinDetail | null>();
      let stop = false;
      for (const row of due) {
        const list = cands.get(row.slug);
        if (!list) continue; // жодної монети з такою назвою: нічого не пишемо, наступного разу це знову безкоштовно
        if (stop) { report.deferred++; continue; }
        // Живі (є в /coins/markets) за капіталізацією; без відповіді markets у порядку списку.
        const ranked = (markets ? list.filter((id) => markets!.has(id)) : list)
          .sort((a, b) => (markets?.get(b)?.market_cap ?? 0) - (markets?.get(a)?.market_cap ?? 0))
          .slice(0, MAX_CANDIDATES);
        const domain = domainOf(row)!;
        const aliases = domainAliases(domain, overrides);
        let found: { id: string; symbol: string } | null = null;
        let failed = false;
        for (const id of ranked) {
          let d = details.get(id);
          if (d === undefined) {
            try {
              d = await cg.coin(id);
            } catch (e) {
              if (e instanceof BudgetExhaustedError || isRateLimit(e)) {
                report.rateLimited ||= isRateLimit(e);
                stop = true;
                failed = true;
                break;
              }
              d = null;
              failed = true;
              report.failed++;
            }
            details.set(id, d);
          }
          if (d && isCompanyToken(d) && homepageConfirms(domain, d.links?.homepage, aliases)) {
            found = { id, symbol: (typeof d.symbol === "string" ? d.symbol : markets?.get(id)?.symbol ?? "").toUpperCase().slice(0, 12) };
            break;
          }
        }
        if (found && found.symbol) {
          report.confirmed++;
          matched.set(row.slug, { slug: row.slug, name: row.name, domain, coingeckoId: found.id, symbol: found.symbol, confidence: "homepage" });
          mappings.set(row.slug, { slug: row.slug, coingeckoId: found.id, symbol: found.symbol, confidence: "homepage", checkedAt: at,
            clearPrice: row.coingecko_id !== found.id });
        } else if (failed) {
          // Хоч один кандидат не відповів: «не знайдено» не пишемо, компанія лишається на наступний раз.
          report.deferred++;
        } else {
          report.notFound++;
          mappings.set(row.slug, { slug: row.slug, coingeckoId: null, symbol: null, confidence: "none", checkedAt: at,
            clearPrice: row.coingecko_id !== null });
        }
      }
    } catch (e) {
      // Список монет чи пакет кандидатів не відповів (або бюджет/429 ще до пошуку): зіставлення руками пишемо все одно.
      report.rateLimited ||= isRateLimit(e);
      report.deferred = Math.max(report.deferred, due.length - report.confirmed - report.notFound);
      log(`jobs-tokens: CoinGecko search stopped (${shortMsg(e)}); the rest waits for the next run`);
    }
  } else if (due.length > 0) {
    report.deferred = due.length;
  }
  report.calls = cg.calls;

  report.mappings = [...mappings.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  await store.writeTokenMappings(report.mappings);
  report.matches = [...matched.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  report.mapped = report.matches.length;

  const o = report.overrides;
  log(`jobs-tokens${store.dry ? " --dry" : ""}: ${rows.length} companies, ${report.withDomain} with a domain; ` +
    `${report.mapped} with a token (${report.matches.filter((m) => m.confidence === "override").length} set by hand, ` +
    `${report.matches.filter((m) => m.confidence === "homepage").length} confirmed by domain, ${report.confirmed} new); ` +
    `by hand ${o.companies} (${o.noToken} no token, ${o.changed} changed${o.unknownIds.length ? `, unknown to CoinGecko: ${o.unknownIds.join(", ")}` : ""}); ` +
    `search: ${report.due} due, ${report.withCandidates} with a same-name coin, ${report.notFound} not found, ${report.deferred} deferred` +
    `${report.rateLimited ? " (rate limited)" : ""}, ${report.failed} failed; CoinGecko calls ${report.calls} of ${budget}`);

  if (deps.prices !== false) {
    // Нові зіставлення насухо не записані: ціни й на них, щоб звіт показав повну картину.
    report.prices = await runTokenPrices({ store, env, log, fetch: deps.fetch, now,
      extraIds: report.matches.map((m) => m.coingeckoId) });
  }
  report.rowsWritten = { estimated: store.estimatedRows, measured: store.dry ? null : store.measuredRows };
  return report;
}

// ---------------- ціни ----------------

export interface PricesDeps {
  store: JobsStore;
  env: EngineEnv;
  log?: (line: string) => void;
  fetch?: FetchOptions;
  now?: Date;
  /** Монети поза базою (нові зіставлення сухого прогону). */
  extraIds?: readonly string[];
}

export interface PricesReport {
  dry: boolean;
  skipped: string | null;
  ids: number;
  priced: number;
  /** Монети, яких /simple/price не повернув (перейменовані чи зниклі). */
  missing: string[];
  calls: number;
  /** Збій запиту: ціни лишились попередні. */
  error: string | null;
  prices: TokenPrice[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Відповідь /simple/price → ціни; без ціни в долярах монета пропускається. */
export function parsePrices(body: unknown, ids: readonly string[], now: Date): TokenPrice[] {
  if (!body || typeof body !== "object") return [];
  const out: TokenPrice[] = [];
  for (const id of ids) {
    const r = (body as Record<string, unknown>)[id];
    if (!r || typeof r !== "object") continue;
    const q = r as Record<string, unknown>;
    const price = num(q.usd);
    if (price === null || price <= 0) continue;
    const ts = num(q.last_updated_at);
    const updated = ts !== null && ts > 1_000_000_000 && ts * 1000 <= now.getTime() + 3_600_000 ? new Date(ts * 1000) : now;
    const mcap = num(q.usd_market_cap);
    out.push({ coingeckoId: id, priceUsd: price, mcapUsd: mcap !== null && mcap > 0 ? mcap : null, change24h: num(q.usd_24h_change),
      updatedAt: updated.toISOString() });
  }
  return out;
}

/**
 * Оновити ціни всіх зіставлених монет: один запит /simple/price на PRICE_BATCH монет. Ніколи не кидає:
 * збій лишає попередні значення (сайт сховає їх через 3 доби) і пишеться в журнал.
 */
export async function runTokenPrices(deps: PricesDeps): Promise<PricesReport> {
  const { store, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? new Date();
  const report: PricesReport = { dry: store.dry, skipped: null, ids: 0, priced: 0, missing: [], calls: 0, error: null, prices: [] };
  let cg: CoinGecko | null = null;
  try {
    const known = await store.tokenIds();
    if (!known) {
      report.skipped = "companies token columns missing";
      log("jobs-tokens prices: companies.coingecko_id missing (db/jobs/0004 not applied), skipped");
      return report;
    }
    const ids = [...new Set([...known.keys(), ...(deps.extraIds ?? [])])].filter((id) => COIN_ID.test(id)).sort();
    report.ids = ids.length;
    if (ids.length === 0) return report;
    cg = coinGeckoFromEnv(env, deps.fetch ?? {});
    for (let i = 0; i < ids.length; i += PRICE_BATCH) {
      const part = ids.slice(i, i + PRICE_BATCH);
      report.prices.push(...parsePrices(await cg.simplePrice(part), part, now));
    }
    const priced = new Set(report.prices.map((p) => p.coingeckoId));
    report.missing = ids.filter((id) => !priced.has(id));
    report.priced = report.prices.length;
    await store.writeTokenPrices(report.prices, known);
  } catch (e) {
    report.error = shortMsg(e);
  }
  report.calls = cg?.calls ?? 0;
  log(`jobs-tokens prices${store.dry ? " --dry" : ""}: ${report.priced} of ${report.ids} coins priced` +
    `${report.missing.length ? `, missing ${report.missing.slice(0, 10).join(", ")}` : ""}; ${report.calls} CoinGecko calls` +
    (report.error ? `; failed, last prices kept (${report.error})` : ""));
  return report;
}

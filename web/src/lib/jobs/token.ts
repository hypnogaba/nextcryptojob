// Токен роботодавця поруч із вакансією на сайті: чип «$ARB $0.42 · MC $1.9B · +3.1%» і посилання
// на сайт компанії. Дані пише engine (jobs-tokens і ціни після jobs-scan, db/jobs/0004_company_token.sql);
// тут лише читання рядка реєстру, свіжість і формат. Код після першого export дослівно той самий, що
// engine/src/digest/token.ts (parity.test.ts): лист, Telegram, сторінка /jobs і search_jobs пишуть однаково.

/** Ціни, старші за стільки діб, не показуємо: рядок зникає, поки ціни не оновляться. */
export const TOKEN_STALE_DAYS = 3;

/** Стовпці companies з db/jobs/0004, як їх читають добірка й сайт. */
export type TokenColumns = {
  token_symbol?: string | null;
  token_price_usd?: number | null;
  token_mcap_usd?: number | null;
  token_change_24h?: number | null;
  token_updated_at?: string | null;
};

/** Ринкові дані токена компанії. */
export type TokenQuote = {
  /** Тікер великими літерами, без «$» («ARB»). */
  symbol: string;
  priceUsd: number;
  /** Капіталізація; null, якщо CoinGecko її не дав (0 теж null). */
  mcapUsd: number | null;
  /** Зміна ціни за 24 години у відсотках; null, якщо невідомо. */
  change24h: number | null;
  /** Коли ціна була актуальна (ISO). */
  updatedAt: string;
};

/** Що показати: частини окремо (для чипа) і одним рядком (лист, Telegram, search_jobs). */
export type TokenChip = {
  /** «$ARB» */
  symbol: string;
  /** «$0.42» */
  price: string;
  /** «MC $1.9B» або null */
  mcap: string | null;
  /** «+3.1%» або null */
  change: string | null;
  /** «$ARB $0.42 · MC $1.9B · +3.1%» */
  text: string;
};

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.]{0,11}$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Рядок реєстру → ринкові дані; null, якщо тікера, ціни чи часу немає або вони криві. */
export function tokenQuoteOf(row: TokenColumns): TokenQuote | null {
  const symbol = (row.token_symbol ?? "").trim().toUpperCase();
  const price = finite(row.token_price_usd);
  const at = row.token_updated_at?.trim() ?? "";
  if (!SYMBOL_RE.test(symbol) || price === null || price <= 0 || !at || Number.isNaN(Date.parse(at))) return null;
  const mcap = finite(row.token_mcap_usd);
  return { symbol, priceUsd: price, mcapUsd: mcap !== null && mcap > 0 ? mcap : null, change24h: finite(row.token_change_24h), updatedAt: at };
}

/** Чи ще свіжі дані: не старші за TOKEN_STALE_DAYS діб (і не з майбутнього більше ніж на годину). */
export function isFreshQuote(q: TokenQuote, now: Date): boolean {
  const age = now.getTime() - Date.parse(q.updatedAt);
  return age <= TOKEN_STALE_DAYS * 86_400_000 && age >= -3_600_000;
}

/** Ціна: «$60,123» від тисячі, «$101.50» від долара, «$0.135» (три значущі цифри) нижче. */
export function formatTokenPrice(p: number): string {
  if (!(p > 0) || !Number.isFinite(p)) return "$0";
  if (p >= 1000) return `$${Math.round(p).toLocaleString("en-US")}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p < 0.000001) return "<$0.000001";
  // Від 1e-6 String не переходить на запис з експонентою.
  return `$${String(Number(p.toPrecision(3)))}`;
}

/** Сума коротко: «$1.9B», «$59.6B», «$900M», «$2T», «$12K»; до тисячі цілим числом. */
export function formatUsdCompact(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return "$0";
  const units: Array<[number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      const shown = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
      // 999.96B округлюється до 1000B: тоді наступна одиниця.
      if (shown === "1000" && unit !== "T") continue;
      return `$${shown}${unit}`;
    }
  }
  return `$${Math.round(n)}`;
}

/** Зміна за добу: «+3.1%», «-2.2%», «0.0%» (менше 0.05 за модулем). */
export function formatChange(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  if (Math.abs(r) < 0.05) return "0.0%";
  return `${r > 0 ? "+" : "-"}${Math.abs(r).toFixed(1)}%`;
}

/** Чип токена, або null: немає даних чи вони старші за TOKEN_STALE_DAYS діб. */
export function tokenChip(q: TokenQuote | null | undefined, now: Date): TokenChip | null {
  if (!q || !isFreshQuote(q, now)) return null;
  const symbol = `$${q.symbol}`;
  const price = formatTokenPrice(q.priceUsd);
  const mcap = q.mcapUsd !== null ? `MC ${formatUsdCompact(q.mcapUsd)}` : null;
  const change = q.change24h !== null ? formatChange(q.change24h) : null;
  return { symbol, price, mcap, change, text: [`${symbol} ${price}`, mcap, change].filter(Boolean).join(" · ") };
}

/** Сайт компанії з домену реєстру («https://arbitrum.io»); null, якщо домен кривий. */
export function companySiteUrl(domain: string | null | undefined): string | null {
  const d = domain?.trim().toLowerCase().replace(/^www\./, "") ?? "";
  return d.length <= 253 && DOMAIN_RE.test(d) ? `https://${d}` : null;
}

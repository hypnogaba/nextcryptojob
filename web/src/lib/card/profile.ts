// Профіль-доказ під карткою (docs/specs/2026-09-16-proof-profile-design.md): факти з source_facts
// рядками, слова людини, її посилання й контакт. Один об'єкт для сторінки /c/<код>, панелі в
// /profile і PDF, щоб вони не розходились.
//
// Три вигляди:
// - "public": без ключа. Лише факти без імен і посилань, ролі й формат роботи. Базу людей з
//   лідерборду так не зібрати: ні ніків, ні адрес, ні контакту, ні слів людини.
// - "full": ключ ?k= або PDF. Усе, крім схованих пунктів; адреси гаманців лише з show_wallet.
// - "owner": панель у /profile. Як full, але сховані пункти лишаються з позначкою hidden.
// Порожнє поле (null) і нуль рядка не дають: це список доказів, а не бал.
import { deriveChains, type FactRow, onchainYears, safeCity, workModes } from "@/lib/crm/project";
import type { Chain } from "@/lib/crm/types";
import { ROLES, type RoleKey } from "./roles";
import type { ProfileLink, ProfilePrefs } from "./profile-prefs";

export type ProfileMode = "public" | "full" | "owner";

export type SourceGroupKey = "github" | "x" | "wallets" | "youtube" | "site" | "audits";

export type ProofLine = { id: string; text: string; hidden: boolean };

export type ProofGroup = {
  key: SourceGroupKey;
  title: string;
  lines: ProofLine[];
  /** Посилання на профіль джерела; у public завжди null. */
  link: ProfileLink | null;
};

export type WordsItem = { id: "words.role" | "words.target"; label: string; text: string; hidden: boolean };

export type ProfileView = {
  mode: ProfileMode;
  roles: string[];
  /** «Remote», «Remote or Lisbon», «Lisbon» або null. */
  place: string | null;
  groups: ProofGroup[];
  /** Далі лише full і owner; у public порожньо або null. */
  words: WordsItem[];
  links: ProfileLink[];
  contact: { telegram: ProfileLink | null; email: string | null };
  wallets: string[];
};

export type ProfileInput = {
  roles: RoleKey[];
  remoteMode: string | null;
  city: string | null;
  roleText: string | null;
  targetText: string | null;
  telegramUsername: string | null;
  email: string | null;
  identities: { kind: string; value: string }[];
  facts: FactRow[];
  prefs: ProfilePrefs;
  now: Date;
};

// --- Числа ------------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 950 → «950», 1234 → «1.2k», 1500000 → «1.5M». */
export function short(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number, unit: string) => `${(Math.round(v * 10) / 10).toString()}${unit}`;
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "k");
  return String(Math.round(n));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(rows: FactRow[], source: string): Record<string, unknown> | null {
  const row = rows.find((r) => r.source === source);
  if (!row?.facts_json) return null;
  try {
    const v: unknown = JSON.parse(row.facts_json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function values(v: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!v) return [];
  return Object.values(v).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

type Fact = [id: string, value: number | null, text: (n: string, raw: number) => string];

/** Рядки з додатних чисел; id = `<група>.<поле>`. */
function countLines(group: string, facts: Fact[]): { id: string; text: string }[] {
  return facts.flatMap(([field, value, text]) =>
    value !== null && value > 0 ? [{ id: `${group}.${field}`, text: text(short(value), value) }] : [],
  );
}

const plural = (raw: number, one: string, many: string) => (raw === 1 ? one : many);

// --- Джерела ------------------------------------------------------------------------------

function githubLines(f: Record<string, unknown>): { id: string; text: string }[] {
  const lines = countLines("github", [
    ["mergedPrsElsewhere", num(f.mergedPrsElsewhere), (n, r) => `${n} merged ${plural(r, "pull request", "pull requests")} in other people's repositories`],
    ["commits12m", num(f.commits12m), (n, r) => `${n} ${plural(r, "commit", "commits")} in the last 12 months`],
    ["reviews12m", num(f.reviews12m), (n, r) => `${n} code ${plural(r, "review", "reviews")} in the last 12 months`],
    ["reposPushed12m", num(f.reposPushed12m), (n, r) => `${n} ${plural(r, "repository", "repositories")} updated in the last 12 months`],
    ["reposWithSite", num(f.reposWithSite), (n, r) => `${n} ${plural(r, "repository", "repositories")} with a live website`],
    ["stars", num(f.stars), (n, r) => `${n} ${plural(r, "star", "stars")} on own repositories`],
    ["followers", num(f.followers), (n, r) => `${n} ${plural(r, "follower", "followers")} on GitHub`],
  ]);
  const year = typeof f.createdAt === "string" ? /^(\d{4})-/.exec(f.createdAt)?.[1] : undefined;
  if (year) lines.push({ id: "github.createdAt", text: `On GitHub since ${year}` });
  return lines;
}

function xLines(f: Record<string, unknown>): { id: string; text: string }[] {
  return countLines("x", [
    ["followers", num(f.followers), (n, r) => `${n} ${plural(r, "follower", "followers")} on X`],
    ["kol", f.kolSourceGap === true ? null : num(f.kol), (n, r) => `Followed by ${n} notable crypto ${plural(r, "account", "accounts")}`],
    ["own30d", num(f.own30d), (n, r) => `${n} own ${plural(r, "post", "posts")} in the last 30 days`],
    ["ownAvgViews", num(f.ownAvgViews), (n) => `${n} views per post on average`],
  ]);
}

const CHAIN_NAMES: Record<Chain, string> = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  solana: "Solana",
  hyperliquid: "Hyperliquid",
};

const EVM_CHAINS = ["ethereum", "base", "arbitrum", "optimism"] as const;

function walletLines(rows: FactRow[], now: Date): { id: string; text: string }[] {
  const evm = values(parse(rows, "evm"));
  const sol = values(parse(rows, "solana"));
  const hl = values(parse(rows, "hyperliquid"));
  const sum = (xs: (number | null)[]) => {
    const real = xs.filter((x): x is number => x !== null);
    return real.length ? real.reduce((a, b) => a + b, 0) : null;
  };
  const evmChains = evm.flatMap((a) => EVM_CHAINS.map((c) => a[c]).filter((c): c is Record<string, unknown> => !!c && typeof c === "object"));
  const tx = sum([...evmChains.map((c) => num(c.sent)), ...sol.map((s) => num(s.sigs))]);
  const trades = sum([...evmChains.map((c) => num(c.swaps)), ...sol.map((s) => num(s.swaps)), ...hl.map((h) => num(h.fillsRecent))]);
  const volume = sum(hl.map((h) => num(h.volumeUsd)));

  const lines: { id: string; text: string }[] = [];
  const years = onchainYears(rows, now);
  if (years !== null) {
    lines.push({ id: "wallets.age", text: years === 0 ? "Onchain for less than a year" : `Onchain for ${years}+ ${plural(years, "year", "years")}` });
  }
  const chains = deriveChains(rows);
  if (chains.length) lines.push({ id: "wallets.chains", text: `Active on ${chains.map((c) => CHAIN_NAMES[c]).join(", ")}` });
  lines.push(
    ...countLines("wallets", [
      ["tx", tx, (n, r) => `${n} ${plural(r, "transaction", "transactions")}`],
      ["trades", trades, (n, r) => `${n} ${plural(r, "trade", "trades")}`],
      ["hlVolume", volume, (n) => `$${n} traded on Hyperliquid`],
    ]),
  );
  return lines;
}

function youtubeLines(f: Record<string, unknown>): { id: string; text: string }[] {
  return countLines("youtube", [
    ["subscribers", f.hiddenSubscribers === true ? null : num(f.subscribers), (n, r) => `${n} ${plural(r, "subscriber", "subscribers")} on YouTube`],
    ["avgViewsRecent", num(f.avgViewsRecent), (n) => `${n} views per recent video on average`],
    ["videos90d", num(f.videos90d), (n, r) => `${n} ${plural(r, "video", "videos")} in the last 90 days`],
  ]);
}

function siteLines(f: Record<string, unknown>): { id: string; text: string }[] {
  if (f.reachable !== true) return [];
  const lines = countLines("site", [
    ["feedItems", num(f.feedItems), (n, r) => `${n} published ${plural(r, "post", "posts")} on own site`],
    ["items90d", num(f.items90d), (n, r) => `${n} ${plural(r, "post", "posts")} in the last 90 days`],
  ]);
  const ts = num(f.latestTs);
  if (ts !== null && ts > 0) {
    const d = new Date((ts > 1e11 ? ts : ts * 1000));
    lines.push({ id: "site.latestTs", text: `Last post in ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
  }
  return lines;
}

function auditLines(f: Record<string, unknown>): { id: string; text: string }[] {
  return countLines("audits", [
    ["earningsUsd", num(f.earningsUsd), (n) => `$${n} earned in audit contests`],
    ["high", num(f.high), (n, r) => `${n} high-severity ${plural(r, "finding", "findings")}`],
    ["contests", num(f.contests), (n, r) => `${n} audit ${plural(r, "contest", "contests")}`],
  ]);
}

function identityLink(kind: string, value: string): ProfileLink | null {
  switch (kind) {
    case "github":
      return { label: `github.com/${value}`, url: `https://github.com/${encodeURIComponent(value)}` };
    case "x":
      return { label: `@${value}`, url: `https://x.com/${encodeURIComponent(value)}` };
    case "youtube":
      return value.startsWith("@")
        ? { label: `youtube.com/${value}`, url: `https://www.youtube.com/${encodeURIComponent(value)}` }
        : { label: "YouTube channel", url: `https://www.youtube.com/channel/${encodeURIComponent(value)}` };
    case "site":
      return /^https:\/\//.test(value) ? { label: value.replace(/^https:\/\//, ""), url: value } : null;
    case "sherlock":
      return { label: `Sherlock: ${value}`, url: `https://audits.sherlock.xyz/watson/${encodeURIComponent(value)}` };
    default:
      return null;
  }
}

const GROUPS: { key: SourceGroupKey; title: string; identity: string | null }[] = [
  { key: "github", title: "GitHub", identity: "github" },
  { key: "x", title: "X", identity: "x" },
  { key: "wallets", title: "Onchain", identity: null },
  { key: "audits", title: "Audits", identity: "sherlock" },
  { key: "youtube", title: "YouTube", identity: "youtube" },
  { key: "site", title: "Website", identity: "site" },
];

function linesOf(key: SourceGroupKey, rows: FactRow[], now: Date): { id: string; text: string }[] {
  if (key === "wallets") return walletLines(rows, now);
  const f = parse(rows, key);
  if (!f) return [];
  if (key === "github") return githubLines(f);
  if (key === "x") return xLines(f);
  if (key === "youtube") return youtubeLines(f);
  if (key === "site") return siteLines(f);
  return auditLines(f);
}

// --- Вигляд -------------------------------------------------------------------------------

export function placeOf(remoteMode: string | null, city: string | null, withCity: boolean): string | null {
  const modes = workModes(remoteMode);
  const c = withCity ? safeCity(city) : null;
  const remote = modes.includes("remote");
  const onsite = modes.includes("city");
  if (remote && onsite) return c ? `Remote or ${c}` : "Remote or on-site";
  if (remote) return "Remote";
  if (onsite) return c ?? "On-site";
  return null;
}

export function profileView(input: ProfileInput, mode: ProfileMode): ProfileView {
  const hidden = new Set(input.prefs.hidden);
  const keep = <T extends { hidden: boolean }>(items: T[]) => (mode === "owner" ? items : items.filter((i) => !i.hidden));
  const personal = mode !== "public";

  const groups = GROUPS.flatMap(({ key, title, identity }) => {
    const lines = keep(linesOf(key, input.facts, input.now).map((l) => ({ ...l, hidden: hidden.has(l.id) })));
    if (!lines.length) return [];
    const value = identity ? input.identities.find((i) => i.kind === identity)?.value : undefined;
    const link = personal && value ? identityLink(identity!, value) : null;
    return [{ key, title, lines, link }];
  });

  const empty: ProfileView = {
    mode,
    roles: input.roles.map((r) => ROLES[r].name),
    // Місто лише з ключем: разом з фактами воно звужує коло до однієї людини.
    place: placeOf(input.remoteMode, input.city, personal),
    groups,
    words: [],
    links: [],
    contact: { telegram: null, email: null },
    wallets: [],
  };
  if (!personal) return empty;

  const words: WordsItem[] = [];
  const role = input.roleText?.trim();
  if (role) words.push({ id: "words.role", label: "Role in their words", text: role, hidden: hidden.has("words.role") });
  const target = input.targetText?.trim();
  if (target) words.push({ id: "words.target", label: "What they are looking for", text: target, hidden: hidden.has("words.target") });

  const tg = input.telegramUsername?.replace(/^@/, "").trim();
  return {
    ...empty,
    words: keep(words),
    links: input.prefs.links,
    contact: {
      telegram: tg && /^[A-Za-z0-9_]{4,32}$/.test(tg) ? { label: `@${tg}`, url: `https://t.me/${tg}` } : null,
      email: input.email,
    },
    wallets:
      input.prefs.showWallet || mode === "owner"
        ? input.identities.filter((i) => i.kind === "evm" || i.kind === "solana").map((i) => i.value)
        : [],
  };
}

/**
 * Спільні типи engine. Джерело істини: docs/contracts.md (§1 ролі, §2 ідентичності, §3 факти).
 * Правило §3: поле, якого джерело не віддало, дорівнює null, а не 0.
 */

/** §1. Ключі ролей. */
export type RoleKey =
  | "engineer" | "security_auditor" | "devrel" | "data_research" | "product_manager"
  | "bd" | "marketing_content" | "creator_kol" | "community" | "trader"
  | "designer" | "operations_support" | "finance" | "legal_compliance" | "hr_recruiting";

/** Джерела, з яких engine збирає факти (`source_facts.source`). */
export type SourceKey = "x" | "github" | "evm" | "hyperliquid" | "solana" | "youtube" | "site" | "audits" | "dune";

/** §2. `identities.kind`. */
export type IdentityKind = "x" | "github" | "youtube" | "site" | "evm" | "solana" | "sherlock";

/** Результат збирача: факти або людська причина прогалини (`gap_reason`). */
export type Fetched<T> = { ok: true; facts: T } | { ok: false; gap: string };

// §3. Факти джерел (`source_facts.facts_json`).

export type XFacts = { followers: number|null; kol: number|null; kolSourceGap: boolean;
  fetched: number; own: number; repliesMade: number; own30d: number;
  ownAvgLikesRt: number|null; ownAvgViews: number|null; ownAvgReplies: number|null;
  daysCovered: number|null };
// own = власні пости: conversationId == id і текст не починається з "RT @"

export type GithubFacts = { createdAt: string; followers: number; stars: number;   // зірки власних не-форків
  commits12m: number; reviews12m: number; mergedPrsElsewhere: number;       // злиті PR у репо чужих власників
  reposPushed12m: number; reposWithSite: number };

export type EvmChainFacts = { sent: number|null; sentCapped: boolean; firstTs: number|null;
  swaps: number|null; source: 'etherscan'|'blockscout'; gap?: string };
export type EvmFacts = { [address: string]: { ethereum?: EvmChainFacts; base?: EvmChainFacts;
  arbitrum?: EvmChainFacts; optimism?: EvmChainFacts } };

export type HyperliquidFacts = { [address: string]: { volumeUsd: number|null; fillsRecent: number|null } };

export type SolanaFacts = { [address: string]: { sigs: number; sigsOk: number; sigsCapped: boolean;
  firstTs: number|null; sampleSeen: number; sampleSwaps: number; swaps: number|null } };
// swaps = null, якщо sampleSeen < 50 (замала вибірка = прогалина)

export type YoutubeFacts = { channelId: string; subscribers: number|null; hiddenSubscribers: boolean;
  avgViewsRecent: number|null; videos90d: number|null };

export type SiteFacts = { reachable: boolean; feedItems: number; items90d: number; sitemapUrls: number;
  latestTs: number|null };

// v5 (docs/contracts.md §3)
export type AuditsFacts = {
  earningsUsd: number | null;
  high: number | null;
  contests: number | null;
  providers: { [provider: string]: { earningsUsd: number; high: number; medium: number; contests: number } };
  verifiedBy: "github" | "x";
  gap?: string;
};

export type DuneFacts = { spellbookPrs: number | null; spellbookPrs12m: number | null };

/**
 * Усі факти однієї людини для формули (§4). Джерело, яке людина не підключила, відсутнє або null.
 * Джерело, яке не відповіло, теж null, а його причина лежить у `gaps` (`source_facts.gap_reason`).
 */
export type PersonFacts = {
  x?: XFacts | null;
  github?: GithubFacts | null;
  evm?: EvmFacts | null;
  hyperliquid?: HyperliquidFacts | null;
  solana?: SolanaFacts | null;
  youtube?: YoutubeFacts | null;
  site?: SiteFacts | null;
  audits?: AuditsFacts | null;
  dune?: DuneFacts | null;
  gaps?: Partial<Record<SourceKey, string>>;
};

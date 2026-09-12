import type { PersonFacts } from "../types.js";

/** Замала вибірка Solana (транзакцій) = прогалина в обмінах, а не число. */
export const SOLANA_MIN_SAMPLE = 50;
const YEAR_S = 365.25 * 86400;

/** Усі гаманці людини, зведені для джерел onchain і trading (§4). */
export type WalletSummary = {
  ageYears: number | null;   // від найранішої відомої транзакції
  tx: number;                // Σ EVM sent + Σ Solana sigs
  chains: string[];          // мережі з активністю, Hyperliquid рахується
  trades: number;            // Σ EVM swaps + Σ Solana swaps + Σ Hyperliquid fillsRecent
  tradeChains: string[];
  hlVolume: number;
  held: number | null;       // у релізі 1 не збираємо
  tradeGap: boolean;         // хоч одна Solana з невідомими обмінами
};

type SolanaSwapFacts = { sigsOk: number; sigsCapped: boolean; sampleSeen: number; sampleSwaps: number; swaps: number | null };

/** Чи прочитано всі успішні транзакції адреси, а список підписів не обрізаний (договір §3). */
export const solanaFullSample = (s: SolanaSwapFacts): boolean => !s.sigsCapped && s.sampleSeen === s.sigsOk;

/**
 * Обміни адреси Solana, яким можна вірити, або null (невідомо → tradeGap).
 * Договір §3: вибірка менша за SOLANA_MIN_SAMPLE = прогалина; ВИНЯТОК: перевірено всі успішні
 * транзакції (sampleSeen = sigsOk) і список не обрізаний (sigsCapped = false) → кількість точна
 * (sampleSwaps) навіть нижче 50 і навіть 0 для порожнього гаманця.
 */
export function solanaSwapsKnown(s: SolanaSwapFacts): number | null {
  if (solanaFullSample(s)) return Number.isFinite(s.sampleSwaps) ? s.sampleSwaps : s.swaps;
  return s.sampleSeen < SOLANA_MIN_SAMPLE ? null : s.swaps;
}

/**
 * Зводить EVM, Hyperliquid і Solana. null, якщо жодного гаманця з фактами немає.
 * Прогалина всього джерела Solana (`gaps.solana`) робить обміни невідомими (tradeGap).
 */
export function aggregateWallets(f: PersonFacts, nowMs: number): WalletSummary | null {
  const evm = Object.values(f.evm ?? {});
  const hl = Object.values(f.hyperliquid ?? {});
  const sol = Object.values(f.solana ?? {});
  if (!evm.length && !hl.length && !sol.length) return null;

  const firsts: number[] = [];
  const chains = new Set<string>();
  const tradeChains = new Set<string>();
  let tx = 0, trades = 0, hlVolume = 0;
  let tradeGap = !f.solana && f.gaps?.solana !== undefined;

  for (const perAddr of evm) {
    for (const [name, c] of Object.entries(perAddr)) {
      if (!c) continue;
      if (c.firstTs) firsts.push(c.firstTs);
      if ((c.sent ?? 0) > 0) chains.add(name);
      tx += c.sent ?? 0;
      trades += c.swaps ?? 0;
      if ((c.swaps ?? 0) > 0) tradeChains.add(name);
    }
  }
  for (const h of hl) {
    if ((h.fillsRecent ?? 0) > 0 || (h.volumeUsd ?? 0) > 0) {
      chains.add("hyperliquid");
      tradeChains.add("hyperliquid");
    }
    hlVolume += h.volumeUsd ?? 0;
    trades += h.fillsRecent ?? 0;
  }
  for (const s of sol) {
    if (s.firstTs && !s.sigsCapped) firsts.push(s.firstTs);
    if (s.sigs > 0) chains.add("solana");
    tx += s.sigs;
    const swaps = solanaSwapsKnown(s);
    if (swaps === null) tradeGap = true;
    trades += swaps ?? 0;
    if ((swaps ?? 0) > 0) tradeChains.add("solana");
  }

  const oldest = firsts.length ? Math.min(...firsts) : null;
  return {
    ageYears: oldest === null ? null : Math.max(0, (nowMs / 1000 - oldest) / YEAR_S),
    tx, chains: [...chains].sort(), trades, tradeChains: [...tradeChains].sort(), hlVolume,
    held: null, tradeGap,
  };
}

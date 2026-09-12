import { describe, expect, it } from "vitest";
import type { EvmChainFacts, SolanaFacts } from "../types.js";
import { aggregateWallets } from "./wallets.js";

const NOW = Date.UTC(2026, 8, 12);
const YEAR = 365.25 * 86400;
const yearsAgo = (y: number) => Math.round(NOW / 1000 - y * YEAR);

const chain = (o: Partial<EvmChainFacts> = {}): EvmChainFacts =>
  ({ sent: 0, sentCapped: false, firstTs: null, swaps: 0, source: "blockscout", ...o });
const sol = (o: Partial<SolanaFacts[string]> = {}): SolanaFacts[string] =>
  ({ sigs: 0, sigsOk: 0, sigsCapped: false, firstTs: null, sampleSeen: 150, sampleSwaps: 0, swaps: 0, ...o });

describe("aggregateWallets", () => {
  it("без жодного гаманця дає null (а не нулі)", () => {
    expect(aggregateWallets({}, NOW)).toBeNull();
    expect(aggregateWallets({ evm: {}, solana: {}, hyperliquid: {} }, NOW)).toBeNull();
    expect(aggregateWallets({ solana: null, gaps: { solana: "node down" } }, NOW)).toBeNull();
  });

  it("вік береться з найранішого firstTs серед EVM і Solana; Solana з обрізаними підписами не рахується", () => {
    const w = aggregateWallets({
      evm: { "0xa": { ethereum: chain({ sent: 3, firstTs: yearsAgo(2) }), base: chain({ sent: 1, firstTs: yearsAgo(1) }) } },
      solana: { S1: sol({ sigs: 10000, sigsCapped: true, firstTs: yearsAgo(5) }), S2: sol({ sigs: 5, firstTs: yearsAgo(3) }) },
    }, NOW)!;
    expect(w.ageYears).toBeCloseTo(3, 6);
  });

  it("tx = надіслані EVM + підписи Solana; мережа рахується раз, навіть з кількох адрес", () => {
    const w = aggregateWallets({
      evm: {
        "0xa": { ethereum: chain({ sent: 10 }), base: chain({ sent: 0 }), arbitrum: chain({ sent: null, gap: "429" }) },
        "0xb": { ethereum: chain({ sent: 5 }), optimism: chain({ sent: 2 }) },
      },
      solana: { S1: sol({ sigs: 7 }) },
    }, NOW)!;
    expect(w.tx).toBe(24);
    expect(w.chains).toEqual(["ethereum", "optimism", "solana"]);
  });

  it("Hyperliquid рахується мережею й торгівлею, лише коли є обсяг або угоди", () => {
    const w = aggregateWallets({
      evm: { "0xa": { ethereum: chain({ sent: 1, swaps: 4 }) }, "0xb": {} },
      hyperliquid: { "0xa": { volumeUsd: 1e6, fillsRecent: 20 }, "0xb": { volumeUsd: 0, fillsRecent: 0 } },
    }, NOW)!;
    expect(w.chains).toEqual(["ethereum", "hyperliquid"]);
    expect(w.trades).toBe(24);
    expect(w.tradeChains).toEqual(["ethereum", "hyperliquid"]);
    expect(w.hlVolume).toBe(1e6);
  });

  it("Solana з вибіркою менше 50 транзакцій: обміни стають прогалиною, а не числом", () => {
    const small = aggregateWallets({ solana: { S1: sol({ sigs: 40, sampleSeen: 40, swaps: 30 }) } }, NOW)!;
    expect(small.trades).toBe(0);
    expect(small.tradeChains).toEqual([]);
    expect(small.tradeGap).toBe(true);

    const enough = aggregateWallets({ solana: { S1: sol({ sigs: 400, sampleSeen: 50, swaps: 30 }) } }, NOW)!;
    expect(enough.trades).toBe(30);
    expect(enough.tradeChains).toEqual(["solana"]);
    expect(enough.tradeGap).toBe(false);
  });

  it("Solana з swaps = null або Solana, що не відповіла, дає tradeGap", () => {
    expect(aggregateWallets({ solana: { S1: sol({ sigs: 3, swaps: null }) } }, NOW)!.tradeGap).toBe(true);
    const w = aggregateWallets({ evm: { "0xa": { ethereum: chain({ sent: 1 }) } }, gaps: { solana: "node down" } }, NOW)!;
    expect(w.tradeGap).toBe(true);
  });

  it("held у релізі 1 не збираємо: null, а не 0", () => {
    expect(aggregateWallets({ evm: { "0xa": { ethereum: chain({ sent: 1 }) } } }, NOW)!.held).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { scorePerson } from "../src/formula/score.js";
import { toPersonFacts } from "../src/pipeline/collect.js";
import type { PersonFacts } from "../src/types.js";
import { NOT_IN_RESEARCH, outcomesFromFacts } from "./research-cache.js";

const NOW = Date.UTC(2026, 8, 13);
const facts: PersonFacts = {
  x: { followers: 900, kol: 3, kolSourceGap: false, fetched: 50, own: 10, repliesMade: 40, own30d: 4, ownAvgLikesRt: 12,
    ownAvgViews: 900, ownAvgReplies: 2, daysCovered: 30 },
  github: null,
  evm: { "0xa": { ethereum: { sent: 400, sentCapped: false, firstTs: 1_500_000_000, swaps: 30, source: "etherscan" } } },
  // adaptHarness: без вибірки sampleSeen = Infinity («не замала»); у JSON це був би null.
  solana: { S1: { sigs: 500, sigsOk: 480, sigsCapped: false, firstTs: null, sampleSeen: Number.POSITIVE_INFINITY, sampleSwaps: 0,
    swaps: 120 } },
  gaps: { github: "HTTP 502" },
};

describe("outcomesFromFacts", () => {
  it("після запису в JSON дає ті самі факти для формули: ті самі бали", () => {
    const out = outcomesFromFacts(facts, ["x", "github", "dune", "evm", "hyperliquid", "solana"]);
    const back = toPersonFacts(JSON.parse(JSON.stringify(out)));
    const a = scorePerson(facts, NOW), b = scorePerson(back, NOW);
    expect(b.sources).toEqual(a.sources);
    for (const role of Object.keys(a.roles) as Array<keyof typeof a.roles>) expect(b.roles[role].score, role).toBe(a.roles[role].score);
    expect(b.sources.trading).toBeGreaterThan(0);   // обміни Solana не стали «вибіркою замалою»
  });

  it("прогалина лишається прогалиною з тією самою причиною; заплановане, але відсутнє, стає прогалиною, а не нулем", () => {
    const out = outcomesFromFacts(facts, ["x", "github", "dune", "evm", "hyperliquid", "solana"]);
    expect(out.github).toEqual({ result: { ok: false, gap: "HTTP 502" }, ms: 0 });
    expect(out.dune).toEqual({ result: { ok: false, gap: NOT_IN_RESEARCH }, ms: 0 });
    expect(out.hyperliquid).toEqual({ result: { ok: false, gap: NOT_IN_RESEARCH }, ms: 0 });
    expect(out.youtube).toBeUndefined();   // не заплановане й відсутнє: у кеші його немає
  });
});

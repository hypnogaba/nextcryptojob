# Trader role calibration (formula v5), 13.09.2026

Research only. No production code changed, nothing deployed. The per-person rows are in
`research/data/trader_calib_2026-09-13.json` (gitignored). This report has aggregate numbers only.
The single named person is the owner.

## 1. Answer

Yes, the trader role is too easy to max out. There are three causes, and the biggest one is not in the formula text.

1. **`held = null` inflates production by 100/85.** The contract says `held` is null in release 1.
   `combine` drops null terms, so the other three trading terms are divided by 85 instead of 100.
   The research harness that produced the published gate result (85% within one level, 12.09) counted
   `held` as 0. So **production runs a trader formula that was never gated.** `npm run parity` shows
   this: engine = Python only in `held_null` mode, and all 17 trader scores differ from the gated
   numbers, by up to 12 points.
2. **Breadth saturates.** `lin(|tradeChains|, 4)` gives full points at 4 of the 6 chains the collector
   reads. Onchain (20% of the trader core) rewards age, tx count and chains again. In the reference set,
   neither separates traders from non-traders (section 3.3). Only trade count does.
3. **Scales are low for a "top of the industry = 90-100" rule.** $5M of Hyperliquid volume and 3,000
   trades get full points. Our own collectors read up to 10,000 transactions per chain.

Recommendation: **option C, "size over breadth"** (section 5). The trading source is rebuilt from the
three facts we actually collect: trades 60, Hyperliquid volume 30, trade chains 10. The scales are set to
the collector ceiling and the industry top. `held` is removed. The trader core becomes trading 90,
onchain 10.

| | v5 as gated (held = 0) | v5 in production (held = null) | Option C |
|---|---|---|---|
| Exact level, 49 labeled | 21/49 (42.9%) | 20/49 (40.8%) | 21/49 (42.9%) |
| Within one level | 42/49 (85.7%) | 42/49 (85.7%) | 42/49 (85.7%) |
| 2-level misses (all / in trader rows) | 6 / 0 | 6 / 0 | 6 / 0 |
| Trader L8+ (16 people with a trader score, owner excluded) | 2 | 4 | 2 |
| of them with no trader label | 1 | 3 | 1 |
| **Owner trader, live facts** | 76.4 (L8) | **85.8 (L9)** | **69.0 (L7)** |
| Owner trader, cached research record | 81.8 | 92.4 | 76.9 |

The owner's next role is 61.0. The gap drops from 24.8 points to 8.0.

The 6 two-level misses are the same people in every variant: 2 security auditors, 2 product managers,
1 engineer, 1 creator. All of them are in non-trader roles and none changes. The one unscored row is the
A-labeled trader, where the Solana sample is too small. That is a data gap.

## 2. What was run

- Data: cached facts in `research/data/raw_all.json` + `raw_extra.json`, labels in `people_all.json` and
  `reference_set.json`. There were no external API calls, and the Helius key was not used.
- `cd research/harness && python3 trader_calib.py ../data` evaluates each variant on the full reference set.
  It changes only the trader role and computes every other role with `score_v5` unchanged. It also
  prints the fact separation and the sensitivity grid.
- `cd engine && npm run parity` confirms that the engine matches Python v5 with `held = null` (max diff 0.000).
  It differs from the gated `held = 0` numbers on all 17 trader scores (max 12.0 points).
- Owner live facts come from the 12.09 run: 342 trades, 5 trade chains, $36.7k Hyperliquid volume. For
  onchain, 6 chains, 5.6 years and about 8.3k tx give onchain 96.9, with x 46.3 and site 31.4. Together
  these reproduce the production trader score of 85.8 exactly. The cached research record for the owner
  is older: it has 1,445 trades, of which 1,151 are Solana swaps extrapolated from a 150-tx sample.

## 3. Findings

### 3.1 Distribution of trader levels (16 people with a trader score, owner excluded)

| Variant | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 |
|---|---|---|---|---|---|---|---|---|---|
| v5 as gated | 1 | 2 | 1 | 3 | 5 | 2 | 1 | 1 | |
| v5 production | 1 | 1 | 2 | 1 | 3 | 4 | 2 | 1 | 1 |
| Option C | 2 | 2 | 3 | 1 | 5 | 1 | 1 | | 1 |

In production, 4 of the 16 reach L8+. Three of them have no trader label, as main role or as listed
secondary role: they are labeled engineer, devrel or research. The only labeled trader at L8+ is the
B-labeled Hyperliquid whale, at L10.

Labeled trader rows (expected band → scored band): v5 as gated A→unscored, B→A, C→C, D→C.
Production adds C→B, which costs 1 exact. Option C gives back the gated result: B→A, C→C, D→C.

### 3.2 The three suspicions, checked

| Suspicion | Verdict | Evidence |
|---|---|---|
| 5 chains saturate the 4-chain cap | True | 5 of 17 trade wallets have 4+ trade chains. Each gets the full 20 points. |
| `held = null` is dropped instead of counting | True, the biggest single cause | It inflates trading by 17.6% in production. Owner trading goes from 66.4 (as gated) to 78.2. Every trader score is affected. |
| Onchain reaches ~97 easily | Partly | Only 2 of 17 trade wallets have onchain ≥ 90 (the owner is one of them). But onchain does not separate traders from others (3.3). |

### 3.3 What separates labeled traders from the rest

Here, people with trades are split by whether they carry a trader label (main or secondary role).

| Group | n | Onchain, mean | Trade chains, mean | Trades, median | Hyperliquid volume > 0 |
|---|---|---|---|---|---|
| Trader label | 4 | 70.2 | 2.25 | 2,775 | 1 |
| No trader label | 12 | 68.7 | 2.50 | 27 | 2 |

Onchain and chain breadth are the same in both groups, or slightly higher for non-traders. Trade count
separates them by two orders of magnitude. Yet v5 gives 36% of the trader core to breadth and age:
tradeChains is 16% (20% of the 80 trading weight) and onchain is 20%.

Mean trader score by trade count cohort:

| Trades | n | v5 as gated | v5 production | Option C |
|---|---|---|---|---|
| 1-99 | 8 | 37.1 (max L6) | 40.8 (max L7) | 29.1 (max L6) |
| 100-999 | 3 | 66.3 (max L8) | 74.3 (max L9) | 58.1 (max L8) |
| 1,000+ | 5 | 63.5 (max L9) | 71.6 (max L10) | 64.7 (max L10) |

In production, the 100-999 cohort (multichain DeFi wallets) scores higher on average than the 1,000+
cohort. With option C, the score rises with trade count. Wallets with 20-30 trades spread over 3-4
chains drop from about 50-54 (C band) to about 35 (D band).

### 3.4 The gate cannot see this problem

The reference set has only 4 trader labels (1 unscored for a data gap). Their within-one outcome does not
depend on the formula: 11 of 12 variants give 42/49. So the gate cannot be the only guard for the trader
role. This report adds two checks: L8+ among people with no trader label, and the cohort order above.

## 4. Options evaluated (full reference set, 49 labeled rows)

| Variant | Exact | Within one | 2-level (all/trader) | Trader L8+ | L8+ no label | Owner live | Owner cached |
|---|---|---|---|---|---|---|---|
| v5 as gated (held = 0) | 21 | 42 (85.7%) | 6/0 | 2 | 1 | 76.4 | 81.8 |
| v5 production (held = null) | 20 | 42 (85.7%) | 6/0 | 4 | 3 | 85.8 | 92.4 |
| S1: production, only chains lin 6 | 21 | 42 | 6/0 | 3 | 2 | 82.7 | 89.2 |
| S2: production, only trades cap 10k | 21 | 42 | 6/0 | 4 | 3 | 81.8 | 87.3 |
| A: drop held; trades cap 10k, chains lin 6, volume cap $1B; weights 45/20/20 | 21 | 42 | 6/0 | 2 | 1 | 75.3 | 80.9 |
| B: held = 0 until collected (coverage penalty) + chains lin 6 | 21 | 42 | 6/0 | 2 | 1 | 73.7 | 79.2 |
| **C: size over breadth** (below) | **21** | **42** | **6/0** | **2** | **1** | **69.0** | **76.9** |
| D: production + cap at 69.9 without 1,000 trades or $1M volume | 20 | 42 | 6/0 | 2 | 1 | 69.9 | 92.4 |
| E: C + the D cap | 21 | 42 | 6/0 | 1 | 0 | 69.0 | 76.9 |
| C1: C weights on old scales (3k, lin 4, $5M) | 21 | 41 (83.7%) | 7/1 | 3 | 2 | 82.6 | 90.2 |
| C2: C trading, core stays 80/20 | 21 | 42 | 6/0 | 2 | 1 | 72.5 | 79.0 |
| C3: only core 90/10 | 21 | 42 | 6/0 | 4 | 3 | 83.9 | 92.0 |

Why the others lose:
- **S1, S2** (one knob each) leave 2-3 non-traders at L8+ and the owner at L9.
- **A** fixes the scales but still gives breadth 20 of 85 points of trading. Owner still L8.
- **B** puts the gated behaviour back, but it breaks the contract rule "a gap is never 0" for a field that
  is never collected. The owner still gets L8. It is also a trap: when `held` is collected, every score
  jumps.
- **D** puts a cliff on top of an inflated formula. It does not catch a builder whose ~1,900 "swaps" are
  mostly sales of gifted tokens (a known v5 limit). That wallet passes the 1,000-trade test and stays
  L8. Production also loses 1 exact (C→B).
- **E** is C plus a cap that changes one person by 1.4 points (71.3 → 69.9). It adds a rule for almost no
  effect.
- **C1** shows that the scales and the weights must change together. With heavier trade weight on the old
  3,000 cap, the D-labeled single-chain memecoin trader jumps to B. That is a 2-level miss, and the gate
  fails (83.7%).
- **C2 / C3** show both halves of C are needed: trading alone leaves the owner at L8, and the core
  change alone does almost nothing.

Not evaluable on current facts: **one-bot / one-pair concentration** and **recency**. Our facts have no
per-pair split and no swap timestamps. EVM swaps are counts, Solana is a sample count, and Hyperliquid is
volume + fill count. These need new collector fields first (section 8).

## 5. Recommendation: option C, "size over breadth"

```
trading = combine(60·logn(trades, 10000), 10·lin(|tradeChains|, 6), 30·logn(hlVolume, 1000000000))
trader  = core trading 90, onchain 10; bonus x 5, site 5 (unchanged); anchor trading (unchanged)
```

Every constant comes from a rule, not from a person:
- **Trades 60, cap 10,000.** Trade count is the only trading fact we collect on every chain, and it is the
  fact that separates traders (3.3). 10,000 is the collectors' own ceiling: 10,000 signatures on Solana,
  10,000 tx per EVM chain. So the most active trader we can see gets 100, as the v4 rule
  "top of the industry = 90-100" requires.
- **Hyperliquid volume 30, cap $1B.** This is the only size fact we have. The largest volume in the
  reference set is in the billions, so a $5M cap is far below the top. At $1B, $100k gives 0.56 and
  $10M gives 0.78, so size keeps counting all the way up.
- **Trade chains 10, lin 6.** 6 is the number of chains the collector reads (same cap as onchain). Breadth
  stays as a small signal. It does not separate traders, and memecoin traders are single-chain.
- **`held` removed.** It is not collected. A declared-null term reweights the rest without anyone seeing
  it, which is exactly what inflated production.
- **Core 90/10.** Onchain is the same for traders and non-traders in the reference set (70.2 vs 68.7). It
  also counts chains a second time. It stays as a 10% experience signal.

Explanation for the "how scoring works" page, one sentence: *"Trader measures how much you trade
(number of trades and Hyperliquid size); how many chains you touched and how old your wallet is count
a little."*

**Sensitivity.** The grid has 189 points: 7 weight triples around 60/10/30, trades cap 5k/10k/20k,
volume cap $100M/$1B/$10B, core 80/20, 90/10 and 100/0.
- 165 of 189 keep 42/49 within one with no 2-level miss in trader rows.
- Exact is 20-21 at every point. L8+ with no trader label is 0-2 (median 1).
- Owner live ranges from 60.0 to 78.6 (median 70.3); with core 90/10 only, 64.0 to 75.9.
- All 24 failing points have a trade weight of 65+ with cap 5k, or 70 with cap 10k. There the D-labeled
  single-chain trader jumps to B.

C (60 at 10k) sits inside the safe region, with one step of margin on each side.

**What C does not fix (honest limits):**
- The B-labeled Hyperliquid whale stays A (90.7). Labels come from PnL leaderboards, and we measure
  activity and size, not PnL. Under "top = 90-100", no activity formula can put the biggest volume in the
  set at B.
- A Solana-only trader has no size fact, so even at the 10,000-trade ceiling the trader score stays near
  B (about 64). v5 production does the same (about 60), so this is not a regression. It needs a Solana size fact.
- One builder-labeled person with real Hyperliquid activity (six-figure volume, a few hundred trades)
  stays at L8 (71.3). By the facts, this person trades more than the owner. The role is chosen by the
  person, so this only matters if they pick Trader.

## 6. Proposed contract diff (`docs/contracts.md` §4)

```diff
-## 4. Формула v5 (`formula_version = "v5"`; v4 + зміни в кінці розділу)
+## 4. Формула v6 (`formula_version = "v6"`; v4 + зміни v5 і v6 в кінці розділу)
@@
 - `trading` = без гаманців → null; trades = 0 → (tradeGap ? null : 0);
-  інакше combine(45·logn(trades,3000), 20·lin(|tradeChains|,4), 20·logn(hlVolume,5000000), 15·logn(held,20))
-  (`held` у релізі 1 = null)
+  інакше combine(60·logn(trades,10000), 10·lin(|tradeChains|,6), 30·logn(hlVolume,1000000000))
@@
-| trader | trading 80, onchain 20 | x 5, site 5 | trading |
+| trader | trading 90, onchain 10 | x 5, site 5 | trading |
@@ (після блоку «Зміни v5», перед `breakdown_json`)
+Зміни v6 (дослідження 13.09, research/trader-calibration-2026-09-13.md):
+- `trading`: розмір замість широти. Угоди 60 (шкала до 10 000 = стеля збирачів), обсяг Hyperliquid 30
+  (шкала до $1 млрд = рівень топів), мережі угод 10 (lin до 6 = усі мережі збирача). `held` прибрано:
+  поле не збираємо, а null у combine мовчки ділив решту на 85 замість 100.
+- trader: ядро trading 90, onchain 10 (onchain однаковий у трейдерів і не-трейдерів еталону: 70 проти 69).
+- Прогін воріт також друкує, скільки людей без мітки трейдера в еталоні мають трейдера L8+
+  (v5 на проді: 3, v6: 1): 4 мітки трейдера замало, щоб ворота бачили зміни цієї ролі.
@@
-{ "formula": "v5", "sources": {"x": 46.3, "gh_eng": 28.9, "...": null},
+{ "formula": "v6", "sources": {"x": 46.3, "gh_eng": 28.9, "...": null},
```

The last bullet of the v6 block is optional. It makes the check from 3.4 a printed metric, not a
pass/fail rule, so the next trader change is judged on more than the 4 labeled rows.

## 7. Files that would change

Engine (formula):
- `engine/src/formula/sources.ts`: `srcTrading` gets new weights and scales, and the `held` term goes.
- `engine/src/formula/roles.ts`: `trader: one({ trading: 90, onchain: 10 })`.
- `engine/src/formula/wallets.ts`: `held` is removed from `WalletSummary` and from the returned object.
- `engine/src/formula/score.ts`: `FORMULA_VERSION = "v6"`.
- Tests: `sources.test.ts` has a `wallet()` helper and the test "held = null не тягне торгівлю вниз",
  to be replaced by behaviour tests: 5 chains do not saturate; a 20-trade wallet on 4 chains stays in the
  D band; 10k trades + 6 chains + $1B = 100. `wallets.test.ts` has the held-is-null test, which gets
  removed. `score.test.ts`: recheck the trader expectations.

Research parity (so the gate measures what production runs):
- `research/harness/score_v6.py` (new): v5 + the new `src_trading` + the trader row.
- `engine/scripts/dump_v5.py`, `engine/scripts/parity.ts`: point them at v6. The `held_null` / `as_is`
  split goes away because there is no `held` any more.

Web (display and version):
- `web/src/lib/roles/recipes.ts`: trader recipe 80/20 → 90/10.
- `web/src/lib/crm/types.ts`: `FORMULA_VERSION = "v6"`.
- `web/src/lib/card/example.ts`, plus the `v5` comments in `web/src/lib/card/back.ts` and `recipes.ts`.

Rollout order: web shows scores only for a formula version with a passed `quality_runs` row. So
deploy the engine, re-score everyone, pass the v6 quality run on the VPS, and only then bump
`FORMULA_VERSION` in web. The same rule applies to other parallel tracks: deploy only from a fresh main.

## 8. Follow-ups (need new facts, not part of this change)

- **Pair concentration and recency.** Hyperliquid `userFills` already returns `coin` and `time` for each
  fill. The Solana sample has `blockTime`. With these, "most fills in one pair" and "no trade in 90 days"
  can be measured at no extra request cost. Then a bot or one-pair cap can be gated on real data.
- **Solana size.** Summing the USD value of the sampled swaps would give Solana traders a size fact to
  match `hlVolume`.
- **Solana swap estimate stability.** The owner's cached and live trade counts differ by 4x (1,445 vs 342),
  mostly from the 150-tx Solana extrapolation. With cap 10k, that swing is about 8 trader points.
- **The 6 non-trader 2-level misses.** The gate says "no 2-level miss without a data gap". Each of the 6
  needs a recorded data-gap reason, or it fails that clause. They are the same before and after this change.

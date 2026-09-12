/**
 * Живий прогін збирачів гаманців на гаманцях власника (власник погодився).
 *
 *   ETHERSCAN_KEY="$(security find-generic-password -s nextcryptojob-etherscan -a etherscan -w)" \
 *     npm run smoke:wallets [-- <evm> <solana>]
 *
 * Ключі не друкуються: лише «є/немає». Без HELIUS_KEY і BLOCKSCOUT_KEY видно
 * задокументовані запасні шляхи (публічні сервери) або прогалини з причиною.
 */
import { collectEvm } from "../src/collectors/evm.js";
import { collectHyperliquid } from "../src/collectors/hyperliquid.js";
import type { Collected } from "../src/collectors/onchain.js";
import { collectSolana } from "../src/collectors/solana.js";

const EVM = process.argv[2] ?? "0xE6b532E63F228087e26a5897131f2e1D043e27f2";
const SOL = process.argv[3] ?? "BGjMfx5Bc9647ydxh2WJ1ow5pWZEjanMugTe5snXKY1z";

const has = (k: string): string => (process.env[k]?.trim() ? "set" : "missing");
console.log(`keys: ETHERSCAN_KEY ${has("ETHERSCAN_KEY")}, BLOCKSCOUT_KEY ${has("BLOCKSCOUT_KEY")}, HELIUS_KEY ${has("HELIUS_KEY")}`);
console.log(`selector cache: ${process.env.SELECTOR_CACHE ?? "./data/selectors.json"}\n`);

async function timed<T>(name: string, fn: () => Promise<Collected<T>>): Promise<{ name: string; seconds: number; res: Collected<T> | { ok: false; gap: string } }> {
  const t0 = performance.now();
  let res: Collected<T> | { ok: false; gap: string };
  try { res = await fn(); } catch (e) { res = { ok: false, gap: `threw: ${e instanceof Error ? e.message : String(e)}` }; }
  return { name, seconds: Math.round((performance.now() - t0) / 100) / 10, res };
}

const day = (ts: number | null): string => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "null");

const [evm, hl, sol] = await Promise.all([
  timed("evm", () => collectEvm([EVM])),
  timed("hyperliquid", () => collectHyperliquid([EVM])),
  timed("solana", () => collectSolana([SOL])),
]);

console.log(`EVM ${EVM.toLowerCase()} (${evm.seconds} s)`);
if (!evm.res.ok) console.log(`  gap: ${evm.res.gap}`);
else {
  for (const [chain, c] of Object.entries(evm.res.facts[EVM.toLowerCase()] ?? {})) {
    console.log(`  ${chain.padEnd(9)} ${c.source.padEnd(10)} sent=${c.sent}${c.sentCapped ? "+" : ""} swaps=${c.swaps} first=${day(c.firstTs)}${c.gap ? `  gap: ${c.gap}` : ""}`);
  }
}

console.log(`\nHyperliquid (${hl.seconds} s)`);
if (!hl.res.ok) console.log(`  gap: ${hl.res.gap}`);
else for (const [a, f] of Object.entries(hl.res.facts)) console.log(`  ${a} volumeUsd=${f.volumeUsd} fillsRecent=${f.fillsRecent}`);

console.log(`\nSolana ${SOL} (${sol.seconds} s, ${has("HELIUS_KEY") === "set" ? "Helius" : "public RPC fallback"})`);
if (!sol.res.ok) console.log(`  gap: ${sol.res.gap}`);
else {
  for (const [a, f] of Object.entries(sol.res.facts)) {
    console.log(`  ${a.slice(0, 6)}… sigs=${f.sigs}${f.sigsCapped ? "+" : ""} ok=${f.sigsOk} first=${day(f.firstTs)} sample=${f.sampleSwaps}/${f.sampleSeen} swaps=${f.swaps}`);
  }
  if (sol.res.partial) console.log(`  partial: ${JSON.stringify(sol.res.partial)}`);
}

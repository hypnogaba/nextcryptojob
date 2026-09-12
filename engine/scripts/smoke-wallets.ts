/**
 * Живий прогін збирачів гаманців. Адреси лише з командного рядка: у файлах чужих
 * (і власних) гаманців не тримаємо. Проганяти лише гаманці, власник яких погодився.
 *
 *   ETHERSCAN_KEY="$(security find-generic-password -s nextcryptojob-etherscan -a etherscan -w)" \
 *     npm run smoke:wallets -- <evm-адреса> <solana-адреса>
 *
 * SMOKE_PARALLEL=3 збирає тих самих N «людей» одночасно в одному процесі (спільні бюджети
 * limits.ts, як у раннері) і друкує час кожного.
 *
 * Ключі не друкуються: лише «є/немає». Без HELIUS_KEY і BLOCKSCOUT_KEY видно
 * задокументовані запасні шляхи (публічні сервери) або прогалини з причиною.
 */
import { collectEvm } from "../src/collectors/evm.js";
import { collectHyperliquid } from "../src/collectors/hyperliquid.js";
import type { Collected } from "../src/collectors/onchain.js";
import { collectSolana } from "../src/collectors/solana.js";

const [EVM, SOL] = process.argv.slice(2);
if (!EVM || !SOL) {
  console.error("usage: npm run smoke:wallets -- <evm-address> <solana-address>");
  process.exit(2);
}

const has = (k: string): string => (process.env[k]?.trim() ? "set" : "missing");
console.log(`keys: ETHERSCAN_KEY ${has("ETHERSCAN_KEY")}, BLOCKSCOUT_KEY ${has("BLOCKSCOUT_KEY")}, HELIUS_KEY ${has("HELIUS_KEY")}`);
console.log(`selector cache: ${process.env.SELECTOR_CACHE ?? "./data/selectors.json"}, deadline ${process.env.ENGINE_DEADLINE_MS ?? 45000} ms\n`);

async function timed<T>(name: string, fn: () => Promise<Collected<T>>): Promise<{ name: string; seconds: number; res: Collected<T> | { ok: false; gap: string } }> {
  const t0 = performance.now();
  let res: Collected<T> | { ok: false; gap: string };
  try { res = await fn(); } catch (e) { res = { ok: false, gap: `threw: ${e instanceof Error ? e.message : String(e)}` }; }
  return { name, seconds: Math.round((performance.now() - t0) / 100) / 10, res };
}

const day = (ts: number | null): string => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "null");

const person = () => Promise.all([
  timed("evm", () => collectEvm([EVM])),
  timed("hyperliquid", () => collectHyperliquid([EVM])),
  timed("solana", () => collectSolana([SOL])),
] as const);

const n = Math.max(1, Number(process.env.SMOKE_PARALLEL) || 1);
const people = await Promise.all(Array.from({ length: n }, person));
if (n > 1) {
  people.forEach((p, i) => {
    const sol = p[2].res;
    const sigs = sol.ok ? Object.values(sol.facts).map((f) => `${f.sigs}${f.sigsCapped ? "+" : ""}`).join(",") : "gap";
    const note = sol.ok && sol.partial ? ` (${Object.values(sol.partial).join("; ")})` : "";
    console.log(`person ${i + 1}: ${p.map((s) => `${s.name} ${s.seconds} s`).join(", ")}; solana sigs ${sigs}${note}`);
  });
  console.log("");
}
const [evm, hl, sol] = people[0]!;

console.log(`EVM ${EVM.toLowerCase()} (${evm.seconds} s)`);
if (!evm.res.ok) console.log(`  gap: ${evm.res.gap}`);
else {
  for (const [chain, c] of Object.entries(evm.res.facts[EVM.toLowerCase()] ?? {})) {
    console.log(`  ${chain.padEnd(9)} ${c.source.padEnd(10)} sent=${c.sent}${c.sentCapped ? "+" : ""} swaps=${c.swaps} first=${day(c.firstTs)}${c.gap ? `  gap: ${c.gap}` : ""}`);
  }
}

console.log(`\nHyperliquid (${hl.seconds} s)`);
if (!hl.res.ok) console.log(`  gap: ${hl.res.gap}`);
else {
  for (const [a, f] of Object.entries(hl.res.facts)) console.log(`  ${a} volumeUsd=${f.volumeUsd} fillsRecent=${f.fillsRecent}`);
  if (hl.res.partial) console.log(`  partial: ${JSON.stringify(hl.res.partial)}`);
}

console.log(`\nSolana ${SOL} (${sol.seconds} s, ${has("HELIUS_KEY") === "set" ? "Helius" : "public RPC fallback"})`);
if (!sol.res.ok) console.log(`  gap: ${sol.res.gap}`);
else {
  for (const [a, f] of Object.entries(sol.res.facts)) {
    console.log(`  ${a.slice(0, 6)}… sigs=${f.sigs}${f.sigsCapped ? "+" : ""} ok=${f.sigsOk} first=${day(f.firstTs)} sample=${f.sampleSwaps}/${f.sampleSeen} swaps=${f.swaps}`);
  }
  if (sol.res.partial) console.log(`  partial: ${JSON.stringify(sol.res.partial)}`);
}

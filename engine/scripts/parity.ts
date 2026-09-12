// Звірка TypeScript-формули v5 з Python-еталоном (research/harness/score_v5.py) на даних дослідження.
// Запуск: npm run parity. Дані (research/data/raw_all.json, raw_extra.json) у git не лежать: це реальні люди.
// Скрипт нічого не пише на диск і не друкує імен, лише різниці за ролями.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scorePerson } from "../src/formula/score.js";
import type { RoleKey } from "../src/types.js";
import { adaptHarness, type RawExtra, type RawPerson } from "./adapt-harness.js";

const PY_ROLE: Record<string, RoleKey> = {
  "Інженер": "engineer", "Аудитор безпеки": "security_auditor", "DevRel": "devrel", "Дані, дослідження": "data_research",
  "Продакт, проєкт-менеджер": "product_manager", "BD, партнерства": "bd", "Маркетинг, контент": "marketing_content",
  "Креатор, KOL": "creator_kol", "Ком'юніті": "community", "Трейдер": "trader",
};
const TOLERANCE = 0.1;

type PyRole = { score: number; core: number; cover: number; reason: string | null } | null;
type PyDump = { now: number; people: Record<string, { sources: Record<string, number | null>; roles: Record<string, PyRole> }> };

/** Шукає research/ з даними вгору від engine/ (worktree лежить у .worktrees/, дані в основній копії). */
function findResearch(): string | null {
  if (process.env.NCJ_RESEARCH_DIR) return process.env.NCJ_RESEARCH_DIR;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "research");
    if (existsSync(join(cand, "data", "raw_all.json")) && existsSync(join(cand, "harness", "score_v5.py"))) return cand;
    dir = resolve(dir, "..");
  }
  return null;
}

/** Корінь engine/: скрипт працює і з scripts/, і з dist-scripts/scripts/. */
function engineDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) dir = resolve(dir, "..");
  return dir;
}

const research = findResearch();
if (!research) {
  console.log("parity: немає research/data/raw_all.json або research/harness/score_v5.py, пропускаю");
  process.exit(0);
}
const dataDir = join(research, "data");
const raw = JSON.parse(readFileSync(join(dataDir, "raw_all.json"), "utf8")) as Record<string, RawPerson>;
const extraPath = join(dataDir, "raw_extra.json");
const extra = existsSync(extraPath) ? (JSON.parse(readFileSync(extraPath, "utf8")) as Record<string, RawExtra>) : {};

function dump(mode: string): PyDump {
  const out = execFileSync("python3", [join(engineDir(), "scripts", "dump_v5.py"), join(research!, "harness"), dataDir, mode],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as PyDump;
}

type RoleStat = { max: number; n: number; scored: number; nullMismatch: number; reasonMismatch: number; over: number };

function compare(mode: string): { maxDiff: number; srcMax: Record<string, number>; roles: Record<string, RoleStat>; people: number } {
  const py = dump(mode);
  const roles: Record<string, RoleStat> = {};
  const srcMax: Record<string, number> = {};
  let maxDiff = 0;
  for (const [pid, rec] of Object.entries(raw)) {
    const ref = py.people[pid];
    if (!ref) throw new Error("Python не віддав одну з людей");
    const ts = scorePerson(adaptHarness(rec, extra[pid]), py.now * 1000);
    for (const [k, v] of Object.entries(ref.sources)) {
      const t = ts.sources[k as keyof typeof ts.sources];
      const d = v === null || t === null ? (v === t ? 0 : Infinity) : Math.abs(v - t);
      srcMax[k] = Math.max(srcMax[k] ?? 0, d);
    }
    for (const [pyName, pr] of Object.entries(ref.roles)) {
      const key = PY_ROLE[pyName];
      if (!key) throw new Error(`невідома роль Python: ${pyName}`);
      const tr = ts.roles[key];
      const st = (roles[key] ??= { max: 0, n: 0, scored: 0, nullMismatch: 0, reasonMismatch: 0, over: 0 });
      st.n++;
      if (pr === null || tr.score === null) {
        if ((pr === null) !== (tr.score === null)) { st.nullMismatch++; maxDiff = Infinity; }
        continue;
      }
      st.scored++;
      const d = Math.abs(pr.score - tr.score);
      st.max = Math.max(st.max, d);
      if (d > TOLERANCE) st.over++;
      maxDiff = Math.max(maxDiff, d);
      // Python не пише причину, коли переміг перший шлях; договір вимагає 'path:audits'.
      const pyReason = pr.reason ?? (key === "security_auditor" ? "path:audits" : null);
      if (pyReason !== tr.breakdown.reason) st.reasonMismatch++;
    }
  }
  return { maxDiff, srcMax, roles, people: Object.keys(raw).length };
}

let failed = false;
for (const [mode, gate] of [["held_null", true], ["as_is", false]] as const) {
  const r = compare(mode);
  const label = mode === "held_null" ? "Python v5, held = null (як у договорі)" : "Python v5 без змін (held = 0)";
  console.log(`\n== ${label}: ${r.people} людей, макс. різниця балу ${r.maxDiff.toFixed(3)}`);
  console.log("роль                 макс.різн  людей  з балом  null≠  причина≠  >0.1");
  for (const [k, s] of Object.entries(r.roles)) {
    console.log(`${k.padEnd(20)} ${s.max.toFixed(3).padStart(9)}  ${String(s.n).padStart(5)}  ${String(s.scored).padStart(7)}  ${String(s.nullMismatch).padStart(5)}` +
      `  ${String(s.reasonMismatch).padStart(8)}  ${String(s.over).padStart(4)}`);
  }
  console.log("джерела (макс. різн.): " + Object.entries(r.srcMax).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" "));
  if (gate && !(r.maxDiff <= TOLERANCE)) failed = true;
}
if (failed) {
  console.error(`\nparity: різниця з еталоном більша за ${TOLERANCE}`);
  process.exit(1);
}
console.log(`\nparity: гаразд (різниця з еталоном held = null не більша за ${TOLERANCE})`);

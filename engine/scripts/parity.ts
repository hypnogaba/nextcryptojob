// Звірка TypeScript-формули v6 з Python-еталоном (research/harness/score_v6.py) на даних дослідження.
// Запуск: npm run parity. Дані (research/data/raw_all.json, raw_extra.json) у git не лежать: це реальні люди.
// Еталон береться з тієї самої копії репозиторію, що й рушій; дані шукаються вгору (у worktree їх немає).
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

/** Перший каталог `research/<sub>` вгору від engine/, де лежить `file`. */
function findUp(sub: string, file: string): string | null {
  let dir = engineDir();
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "research", sub);
    if (existsSync(join(cand, file))) return cand;
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

// Еталон з цієї копії (worktree має свій score_v6.py), дані з першої копії, де вони є.
// NCJ_RESEARCH_DIR = каталог research/ з обома (harness і data).
const envDir = process.env.NCJ_RESEARCH_DIR;
const harnessDir = envDir ? join(envDir, "harness") : findUp("harness", "score_v6.py");
const dataDir = envDir ? join(envDir, "data") : findUp("data", "raw_all.json");
if (!harnessDir || !dataDir || !existsSync(join(harnessDir, "score_v6.py")) || !existsSync(join(dataDir, "raw_all.json"))) {
  console.log("parity: немає research/data/raw_all.json або research/harness/score_v6.py, пропускаю");
  process.exit(0);
}
const raw = JSON.parse(readFileSync(join(dataDir, "raw_all.json"), "utf8")) as Record<string, RawPerson>;
const extraPath = join(dataDir, "raw_extra.json");
const extra = existsSync(extraPath) ? (JSON.parse(readFileSync(extraPath, "utf8")) as Record<string, RawExtra>) : {};

function dump(): PyDump {
  const out = execFileSync("python3", [join(engineDir(), "scripts", "dump_v6.py"), harnessDir!, dataDir!],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as PyDump;
}

type RoleStat = { max: number; n: number; scored: number; nullMismatch: number; reasonMismatch: number; over: number };

function compare(): { maxDiff: number; srcMax: Record<string, number>; roles: Record<string, RoleStat>; people: number } {
  const py = dump();
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

const r = compare();
console.log(`\n== Python v6 (research/harness/score_v6.py): ${r.people} людей, макс. різниця балу ${r.maxDiff.toFixed(3)}`);
console.log("роль                 макс.різн  людей  з балом  null≠  причина≠  >0.1");
for (const [k, s] of Object.entries(r.roles)) {
  console.log(`${k.padEnd(20)} ${s.max.toFixed(3).padStart(9)}  ${String(s.n).padStart(5)}  ${String(s.scored).padStart(7)}  ${String(s.nullMismatch).padStart(5)}` +
    `  ${String(s.reasonMismatch).padStart(8)}  ${String(s.over).padStart(4)}`);
}
const srcOver = Object.entries(r.srcMax).filter(([, v]) => !(v <= TOLERANCE));
console.log("джерела (макс. різн.): " + Object.entries(r.srcMax).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" "));
const reasonMismatch = Object.values(r.roles).reduce((n, s) => n + s.reasonMismatch, 0);
if (!(r.maxDiff <= TOLERANCE) || srcOver.length || reasonMismatch) {
  console.error(`\nparity: різниця з еталоном більша за ${TOLERANCE} або причини різні`);
  process.exit(1);
}
console.log(`\nparity: гаразд (різниця з еталоном v6 не більша за ${TOLERANCE})`);

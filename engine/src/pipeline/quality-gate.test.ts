import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { FORMULA_VERSION, type PersonScore, scorePerson } from "../formula/score.js";
import { SqliteD1 } from "../testing/sqlite-d1.js";
import type { RoleKey, XFacts } from "../types.js";
import { fakeRegistry, neverResolves, sampleX } from "./fake-registry.js";
import { band, evaluateGate, parseReferencePeople, type ReferencePerson, runQualityGate } from "./quality-gate.js";

/** Мінімальний бал людини для чистої звірки: лише одна роль. */
const fakeScore = (role: RoleKey, score: number | null, gaps: Record<string, string> = {}, reason: string | null = null) => ({
  score: { roles: { [role]: { score, core: score, cover: 100, level: null,
    breakdown: { formula: FORMULA_VERSION, sources: {}, core: {}, bonus: {}, cover: 100, level: null, reason, gaps } } } } as unknown as PersonScore,
  ms: 1,
});
const person = (id: string, expected_role: string, expected_band: ReferencePerson["expected_band"]): ReferencePerson =>
  ({ id, expected_role, expected_band });

describe("band", () => {
  it("межі як в evaluate2.py: A ≥ 80, B ≥ 60, C ≥ 40, інакше D", () => {
    expect([80, 79.9, 60, 59.9, 40, 39.9, 0, 100].map(band)).toEqual(["A", "B", "B", "C", "C", "D", "D", "A"]);
  });
});

describe("evaluateGate", () => {
  it("точно, в межах сусіднього, «не рахується» в знаменнику, '?' пропущено", () => {
    const people = [person("p1", "bd", "A"), person("p2", "bd", "B"), person("p3", "bd", "A"), person("p4", "bd", "C"),
      person("p5", "bd", "D"), person("p6", "bd", "?"), person("p7", "bd", "B")];
    const scored = new Map([["p1", fakeScore("bd", 85)], ["p2", fakeScore("bd", 75)], ["p3", fakeScore("bd", 65)],
      ["p4", fakeScore("bd", 30)], ["p5", fakeScore("bd", 10)], ["p6", fakeScore("bd", 50)],
      ["p7", fakeScore("bd", null, {}, "missing_anchor:x")]]);
    const r = evaluateGate(people, scored, 45_000);
    expect(r).toMatchObject({ people: 6, exact: 3, near: 5, exactPct: 50, nearPct: 83.3, unscored: 1, passed: false });
    expect(r.failReasons[0]).toMatch(/within-one 83.3% < 85%/);
    expect(r.results.p3).toMatchObject({ band: "B", verdict: "near" });
    expect(r.results.p6).toMatchObject({ verdict: "skipped" });
    expect(r.results.p7).toMatchObject({ verdict: "unscored", score: null, reason: "missing_anchor:x" });
  });

  const eightWithMiss = (gaps: Record<string, string>) => {
    const people = Array.from({ length: 8 }, (_, i) => person(`p${i}`, "bd", "A"));
    const scored = new Map(people.map((p, i) => [p.id, i === 7 ? fakeScore("bd", 45, gaps) : fakeScore("bd", 90)]));
    return evaluateGate(people, scored, 45_000);
  };

  it("промах на 2 рівні з прогалиною в джерелі ролі: рахується як «з прогалиною», ворота проходять", () => {
    const r = eightWithMiss({ x: "x: HTTP 503" });
    expect(r).toMatchObject({ nearPct: 87.5, passed: true, twoBandWithGap: 1, twoBandWithoutGap: 0, rule: "within-one >= 85%" });
    expect(r.twoBandMisses).toEqual([{ id: "p7", dataGap: true, gaps: ["x"] }]);
  });

  it("промах на 2 рівні без прогалини (або з прогалиною в чужому для ролі джерелі) не блокує, але лишається в звіті", () => {
    for (const gaps of [{}, { youtube: "youtube: HTTP 403" }] as Array<Record<string, string>>) {
      const r = eightWithMiss(gaps);
      expect(r).toMatchObject({ passed: true, failReasons: [], twoBandWithGap: 0, twoBandWithoutGap: 1 });
      expect(r.twoBandMisses).toEqual([{ id: "p7", dataGap: false, gaps: [] }]);
    }
  });

  it("вирішує лише сусідній рівень: 84,x% не проходить навіть без жодного промаху на 2 рівні", () => {
    // 19 людей: 16 точно, 3 промахи на 2 рівні → 16/19 = 84,2% у межах сусіднього; з 17 точно вже 89,5%.
    const people = Array.from({ length: 19 }, (_, i) => person(`q${i}`, "bd", "A"));
    const scored = new Map(people.map((p, i) => [p.id, fakeScore("bd", i < 16 ? 90 : 45)]));
    const r = evaluateGate(people, scored, 1);
    expect(r).toMatchObject({ nearPct: 84.2, passed: false, twoBandWithoutGap: 3 });
    expect(r.failReasons).toEqual(["within-one 84.2% < 85%"]);
    const ok = new Map(people.map((p, i) => [p.id, fakeScore("bd", i < 17 ? 90 : 45)]));
    expect(evaluateGate(people, ok, 1)).toMatchObject({ nearPct: 89.5, passed: true, twoBandWithoutGap: 2 });
  });

  it("прогалина одного ланцюга EVM рахується для трейдера", () => {
    const people = [person("t", "trader", "A")];
    const r = evaluateGate(people, new Map([["t", fakeScore("trader", 20, { "evm.base": "blockscout: HTTP 502" })]]), 1);
    expect(r.twoBandMisses).toEqual([{ id: "t", dataGap: true, gaps: ["evm.base"] }]);
  });

  it("порожній еталон не проходить", () => {
    expect(evaluateGate([person("q", "bd", "?")], new Map([["q", fakeScore("bd", 50)]]), 1).passed).toBe(false);
  });
});

describe("parseReferencePeople", () => {
  it("перевіряє форму й не цитує імен у помилках", () => {
    expect(() => parseReferencePeople([{ id: "a", name: "Secret Name", expected_role: "wizard", expected_band: "A" }]))
      .toThrow(/еталон\[0\]: невідома expected_role/);
    expect(() => parseReferencePeople([{ id: "a", expected_role: "bd", expected_band: "Z" }])).toThrow(/expected_band/);
    expect(() => parseReferencePeople([{ id: "a", expected_role: "bd", expected_band: "A" }, { id: "a", expected_role: "bd", expected_band: "A" }]))
      .toThrow(/повторюється/);
    const [p] = parseReferencePeople([{ id: "a", name: "N", x: "@Someone", github: "", youtube: null, evm: ["0xAB"], sol: [],
      site: "blog.example", expected_role: "bd", expected_band: "B" }]);
    expect(p).toMatchObject({ id: "a", x: "@Someone", github: null, evm: ["0xAB"], site: "blog.example" });
    expect(p).not.toHaveProperty("name");
  });
});

// Синтетичний еталон через справжній прогін: підставні збирачі, SQLite, CLI і код виходу.
const X_BY_HANDLE: Record<string, XFacts> = {
  synthetic_strong: { followers: 400_000, kol: 800, kolSourceGap: false, fetched: 100, own: 60, repliesMade: 10, own30d: 60,
    ownAvgLikesRt: 1_400, ownAvgViews: 140_000, ownAvgReplies: 140, daysCovered: 30 },
  synthetic_mid: sampleX(),
  synthetic_weak: { followers: 40, kol: 0, kolSourceGap: false, fetched: 10, own: 1, repliesMade: 0, own30d: 1,
    ownAvgLikesRt: 1, ownAvgViews: 20, ownAvgReplies: 0, daysCovered: 30 },
};
const communityScore = (h: string): number => scorePerson({ x: X_BY_HANDLE[h]! }).roles.community.score!;

describe("quality-gate: прогін", () => {
  let dir: string;
  let db: SqliteD1;
  const registry = () => fakeRegistry({ collectX: async (h: string) => ({ ok: true, facts: X_BY_HANDLE[h]! }) });

  const writePeople = (bands: Array<ReferencePerson["expected_band"]>): string => {
    const handles = ["synthetic_strong", "synthetic_mid", "synthetic_weak"];
    const people = handles.map((h, i) => ({ id: `r${i + 1}`, name: `Synthetic Person ${i + 1}`, x: h, github: null, youtube: null,
      evm: [], sol: [], site: null, expected_role: "community", expected_band: bands[i] }));
    people.push({ id: "r4", name: "Synthetic Unknown", x: "synthetic_mid", github: null, youtube: null, evm: [], sol: [], site: null,
      expected_role: "community", expected_band: "?" });
    const path = join(dir, "people.json");
    writeFileSync(path, JSON.stringify(people));
    return path;
  };
  const actualBands = () => ["synthetic_strong", "synthetic_mid", "synthetic_weak"].map((h) => band(communityScore(h)));
  const cli = async (args: string[]) => {
    const out: string[] = [];
    const code = await runCli(["quality-gate", ...args], { env: {}, db: () => db, registry, out: (l) => out.push(l), err: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };
  const runs = () => db.all<{ people: number; exact_pct: number; near_pct: number; unscored: number; report_json: string; passed: number;
    formula_version: string }>("SELECT * FROM quality_runs");

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ncj-gate-")); db = new SqliteD1(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); db.close(); });

  it("синтетичні люди різної сили справді дають різні рівні", () => {
    expect(new Set(actualBands()).size).toBeGreaterThanOrEqual(2);
    expect(actualBands()[0]).toBe("A");
    expect(actualBands()[2]).toBe("D");
  });

  it("усі в своєму рівні: код 0, рядок quality_runs лише з id, без імен і ніків", async () => {
    const { code, out } = await cli([writePeople(actualBands())]);
    expect(code).toBe(0);
    expect(out).toMatch(/quality gate: PASSED/);
    expect(out).not.toMatch(/Synthetic|synthetic_/);
    const [row] = runs();
    expect(row).toMatchObject({ people: 3, exact_pct: 100, near_pct: 100, unscored: 0, passed: 1, formula_version: FORMULA_VERSION });
    expect(row!.report_json).not.toMatch(/Synthetic|synthetic_/);
    expect(Object.keys(JSON.parse(row!.report_json).results).sort()).toEqual(["r1", "r2", "r3"].concat("r4").sort());
  });

  it("промах на 2 рівні (1 з 3 = 66,7% у межах сусіднього): код 1, passed = 0, промах у звіті", async () => {
    const bands = actualBands();
    bands[2] = "A";   // слабкий назван сильним: D проти A
    const { code, out } = await cli([writePeople(bands)]);
    expect(code).toBe(1);
    expect(out).toMatch(/quality gate: FAILED \(within-one 66.7% < 85%\)/);
    expect(out).toMatch(/2-band misses 1 \(with a data gap 0, without 1; tracked, not a gate rule\)/);
    const [row] = runs();
    expect(row).toMatchObject({ passed: 0 });
    expect(JSON.parse(row!.report_json)).toMatchObject({ rule: "within-one >= 85%", twoBandWithoutGap: 1,
      twoBandMisses: [{ id: "r3", dataGap: false }] });
  });

  it("--note іде в report_json.note; звіт каже, скільки фактів з кешу, а скільки зібрано", async () => {
    const { code, out } = await cli([writePeople(actualBands()), "--note", "cached facts from 2026-09-12, reference set 3"]);
    expect(code).toBe(0);
    expect(out).toMatch(/note: cached facts from 2026-09-12, reference set 3/);
    const report = JSON.parse(runs()[0]!.report_json);
    expect(report).toMatchObject({ note: "cached facts from 2026-09-12, reference set 3", facts: { cached: 0, collected: 4 } });
    expect((await cli([writePeople(actualBands()), "--note", "x".repeat(201)])).code).toBe(2);
  });

  it("--cache-only: без каталогу кешу код 2; з неповним кешем падає до збору; з повним нічого не збирає", async () => {
    const path = writePeople(actualBands());
    expect((await cli([path, "--cache-only"])).code).toBe(2);

    const cacheDir = join(dir, "cache");
    const calls: string[] = [];
    const counting = () => fakeRegistry({ collectX: async (h: string) => { calls.push(h); return { ok: true, facts: X_BY_HANDLE[h]! }; } });
    const run = (args: string[]) => runCli(["quality-gate", ...args], { env: {}, db: () => db, registry: counting,
      out: () => undefined, err: () => undefined });
    expect(await run([path, cacheDir, "--cache-only", "--no-db"])).toBe(1);
    expect(calls).toEqual([]);

    expect(await run([path, cacheDir, "--no-db"])).toBe(0);   // наповнює кеш
    calls.length = 0;
    expect(await run([path, cacheDir, "--cache-only"])).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(runs()[0]!.report_json).facts).toEqual({ cached: 4, collected: 0 });
  });

  it("--no-db нічого не пише; зіпсований файл дає код 2 без цитати вмісту", async () => {
    expect((await cli([writePeople(actualBands()), "--no-db"])).code).toBe(0);
    expect(runs()).toEqual([]);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '[{"name": "Secret Person", ');
    const r = await cli([bad]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("Secret Person");
  });

  it("кеш сирих відповідей: другий прогін не ходить у збирачі, окрім тих, що не встигли", async () => {
    const people = parseReferencePeople([
      { id: "c1", x: "synthetic_mid", github: "someone", expected_role: "community", expected_band: "B" }]);
    const cacheDir = join(dir, "cache");
    const first = fakeRegistry({ collectGithub: neverResolves() });
    await runQualityGate(people, { registry: first, env: {}, cacheDir, deadlineMs: 50, log: () => undefined });
    expect(readdirSync(cacheDir)).toEqual(["c1.json"]);

    const second = fakeRegistry();
    await runQualityGate(people, { registry: second, env: {}, cacheDir, deadlineMs: 50, log: () => undefined });
    expect(second.calls.map((c) => c.collector)).toEqual(["collectGithub"]);

    const third = fakeRegistry();
    await runQualityGate(people, { registry: third, env: {}, cacheDir, deadlineMs: 50, log: () => undefined });
    expect(third.calls).toEqual([]);
  });
});

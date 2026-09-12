import { describe, expect, it } from "vitest";
import { SqliteD1 } from "../testing/sqlite-d1.js";
import { collectPerson } from "./collect.js";
import { COLLECTORS, type Collectors, createRealRegistry } from "./realRegistry.js";
import type { CollectorCtx } from "./registry.js";
import { scoreUser } from "./run-person.js";

const NAMES = ["collectX", "collectGithub", "collectSite", "collectYoutube", "collectAudits", "collectDune",
  "collectEvm", "collectHyperliquid", "collectSolana"] as const;

const ctx = (env: Record<string, string> = {}): CollectorCtx => {
  const now = () => 1_000;
  return { env, signal: new AbortController().signal, deadline: 46_000, now };
};

/** Підмінені сирі збирачі: записують, що отримали, і відповідають порожніми фактами. */
function spies(): { c: Collectors; got: Record<string, unknown[]> } {
  const got: Record<string, unknown[]> = {};
  const c = Object.fromEntries(NAMES.map((n) => [n, async (...args: unknown[]) => { got[n] = args; return { ok: true, facts: {} }; }]));
  return { c: c as unknown as Collectors, got };
}

describe("createRealRegistry", () => {
  it("під'єднує всі 9 збирачів src/collectors/", () => {
    const r = createRealRegistry();
    expect(Object.keys(r).sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) expect(typeof r[n]).toBe("function");
    expect(Object.keys(COLLECTORS).sort()).toEqual([...NAMES].sort());
  });

  it("кожен збирач отримує env, signal, межу збору людини і годинник", async () => {
    const { c, got } = spies();
    const r = createRealRegistry(c);
    const x = ctx({ K: "v" });
    await Promise.all([
      r.collectX("h", x), r.collectGithub("l", x), r.collectSite("https://a.b", x), r.collectYoutube("@c", x),
      r.collectAudits("s", { github: "l", x: null }, x), r.collectDune("l", x),
      r.collectEvm(["0xa"], x), r.collectHyperliquid(["0xa"], x), r.collectSolana(["S"], x),
    ]);
    const source = { env: x.env, signal: x.signal, deadlineAt: 46_000, now: x.now };
    const wallet = { env: x.env, signal: x.signal, deadline: 46_000, now: x.now };
    expect(got.collectX).toEqual(["h", source]);
    expect(got.collectGithub).toEqual(["l", source]);
    expect(got.collectSite).toEqual(["https://a.b", source]);
    expect(got.collectYoutube).toEqual(["@c", source]);
    expect(got.collectAudits).toEqual(["s", { github: "l", x: null }, source]);
    expect(got.collectDune).toEqual(["l", source]);
    expect(got.collectEvm).toEqual([["0xa"], wallet]);
    expect(got.collectHyperliquid).toEqual([["0xa"], wallet]);
    expect(got.collectSolana).toEqual([["S"], wallet]);
    for (const args of Object.values(got)) expect((args.at(-1) as { signal: AbortSignal }).signal).toBe(x.signal);
  });

  it("справжні збирачі без ключів дають прогалину 'not configured', без мережі й без винятку", async () => {
    const r = createRealRegistry();
    const x = ctx();
    expect(await r.collectX("someone", x)).toEqual({ ok: false, gap: "not configured: TWITTER_TOKEN" });
    expect(await r.collectGithub("someone", x)).toEqual({ ok: false, gap: "not configured: GITHUB_TOKEN" });
    expect(await r.collectDune("someone", x)).toEqual({ ok: false, gap: "not configured: GITHUB_TOKEN" });
    expect(await r.collectYoutube("@someone", x)).toEqual({ ok: false, gap: "not configured: YOUTUBE_KEY" });
    expect(await r.collectAudits("someone", { github: null, x: null }, x)).toMatchObject({ ok: false, gap: expect.stringMatching(/^audits: no GitHub or X/) });
    expect(await r.collectEvm([], x)).toEqual({ ok: true, facts: {} });
    expect(await r.collectHyperliquid([], x)).toEqual({ ok: true, facts: {} });
    expect(await r.collectSolana([], x)).toEqual({ ok: true, facts: {} });
  });

  it("worker і score-user більше не падають на заглушці: людина рахується з прогалинами", async () => {
    const db = new SqliteD1();
    try {
      db.addUser("u1");
      db.addIdentity("u1", "x", "someone", true);
      db.addIdentity("u1", "github", "someone");
      const s = await scoreUser("u1", { registry: createRealRegistry(), db, env: {}, deadlineMs: 5_000 });
      expect(s.sources).toMatchObject({
        x: { gap: "not configured: TWITTER_TOKEN" }, github: { gap: "not configured: GITHUB_TOKEN" },
        dune: { gap: "not configured: GITHUB_TOKEN" },
      });
      expect(s.gaps.sort()).toEqual(["dune", "github", "x"]);
    } finally {
      db.close();
    }
  });

  it("collectPerson дає справжнім збирачам межу = старт збору + deadlineMs", async () => {
    const { c, got } = spies();
    const before = Date.now();
    await collectPerson({ x: null, github: null, youtube: null, site: null, evm: ["0x" + "a".repeat(40)], solana: [], sherlock: null },
      { registry: createRealRegistry(c), env: {}, deadlineMs: 30_000 });
    const after = Date.now();
    const o = got.collectEvm!.at(-1) as { deadline: number; now: () => number };
    expect(o.deadline).toBeGreaterThanOrEqual(before + 30_000);
    expect(o.deadline).toBeLessThanOrEqual(after + 30_000);
    expect(Math.abs(o.now() - Date.now())).toBeLessThan(1_000);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORMULA_VERSION, scorePerson } from "../formula/score.js";
import { SqliteD1 } from "../testing/sqlite-d1.js";
import type { PersonFacts } from "../types.js";
import {
  fakeRegistry, hangUntilAborted, neverResolves, sampleAudits, sampleDune, sampleEvm, sampleGithub, sampleHyperliquid,
  sampleSolana, sampleX,
} from "./fake-registry.js";
import { groupIdentities, type IdentityRow } from "./identities.js";
import { FAST_FIRST_PASS_DEADLINE_MS, FAST_FIRST_PASS_SAMPLE, scoreUser } from "./run-person.js";

const USER = "user-0001-aaaa";
const EVM_A = "0x" + "a".repeat(40);
const EVM_B = "0x" + "b".repeat(40);
const SOL = "So11111111111111111111111111111111111111112";
const NOW = Date.UTC(2026, 8, 12);
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

type FactRow = { source: string; facts_json: string | null; gap_reason: string | null; fetched_at: string };
type ScoreRow = { role: string; score: number | null; core: number | null; cover: number; breakdown_json: string; formula_version: string };

let db: SqliteD1;
const facts = (): Record<string, FactRow> =>
  Object.fromEntries(db.all<FactRow>("SELECT * FROM source_facts WHERE user_id = ?", USER).map((r) => [r.source, r]));
const scores = (): Record<string, ScoreRow> =>
  Object.fromEntries(db.all<ScoreRow>("SELECT * FROM scores WHERE user_id = ?", USER).map((r) => [r.role, r]));

beforeEach(() => { db = new SqliteD1(); db.addUser(USER); });
afterEach(() => db.close());

const fullIdentities = (xVerified = true, githubVerified = true): void => {
  db.addIdentity(USER, "x", "alice", xVerified);
  db.addIdentity(USER, "github", "alice-gh", githubVerified);
  db.addIdentity(USER, "site", "https://alice.dev");
  db.addIdentity(USER, "evm", EVM_A, true);
  db.addIdentity(USER, "evm", EVM_B);          // вставлений без підпису: однаково рахується
  db.addIdentity(USER, "solana", SOL);
  db.addIdentity(USER, "sherlock", "alice");
};

describe("scoreUser", () => {
  it("збирає всі доречні джерела, пише факти, прогалини й бали всіх ролей", async () => {
    fullIdentities();
    const registry = fakeRegistry({ collectSite: async () => ({ ok: false, gap: "site: HTTP 404" }) });
    const summary = await scoreUser(USER, { registry, db, env: {}, now: () => NOW });

    const inputs = Object.fromEntries(registry.calls.map((c) => [c.collector, c.input]));
    expect(inputs).toEqual({
      collectX: "alice", collectGithub: "alice-gh", collectDune: "alice-gh", collectSite: "https://alice.dev",
      collectEvm: [EVM_A, EVM_B], collectHyperliquid: [EVM_A, EVM_B], collectSolana: [SOL],
      collectAudits: { sherlock: "alice", github: "alice-gh", x: "alice" },
    });

    const f = facts();
    expect(Object.keys(f).sort()).toEqual(["audits", "dune", "evm", "github", "hyperliquid", "site", "solana", "x"]);
    expect(f.site).toMatchObject({ facts_json: null, gap_reason: "site: HTTP 404" });
    expect(JSON.parse(f.github!.facts_json!)).toEqual(sampleGithub());
    expect(JSON.parse(f.evm!.facts_json!)).toEqual(sampleEvm([EVM_A, EVM_B]));
    expect(f.x!.gap_reason).toBeNull();
    for (const row of Object.values(f)) expect(row.fetched_at).toMatch(SQL_TIME);

    const expected = scorePerson({
      x: sampleX(), github: sampleGithub(), dune: sampleDune(), site: null, evm: sampleEvm([EVM_A, EVM_B]),
      hyperliquid: sampleHyperliquid([EVM_A, EVM_B]), solana: sampleSolana([SOL]), audits: sampleAudits(),
      gaps: { site: "site: HTTP 404" },
    } satisfies PersonFacts, NOW);
    const s = scores();
    expect(Object.keys(s)).toHaveLength(15);
    for (const [role, rr] of Object.entries(expected.roles)) {
      expect(s[role]).toMatchObject({ score: rr.score, core: rr.core, cover: rr.cover, formula_version: FORMULA_VERSION });
      expect(JSON.parse(s[role]!.breakdown_json)).toEqual(rr.breakdown);
    }
    expect(s.engineer!.score).toBeGreaterThan(0);
    expect(JSON.parse(s.engineer!.breakdown_json).gaps).toEqual({ site: "site: HTTP 404" });
    expect(s.designer).toMatchObject({ score: null });
    expect(JSON.parse(s.designer!.breakdown_json).reason).toBe("needs_portfolio");

    expect(summary.gaps).toEqual(["site"]);
    expect(summary.sources.site).toMatchObject({ gap: "site: HTTP 404" });
    expect(summary.scored).toBeGreaterThan(0);
  });

  it("модель довіри 13.09: самозаявлений X збирається й дає бал, але профіль Sherlock з ним не звіряється", async () => {
    fullIdentities(false);
    const registry = fakeRegistry();
    const summary = await scoreUser(USER, { registry, db, env: {}, now: () => NOW });
    expect(registry.calls.find((c) => c.collector === "collectX")!.input).toBe("alice");
    expect(registry.calls.find((c) => c.collector === "collectAudits")!.input).toEqual({ sherlock: "alice", github: "alice-gh", x: null });
    expect(JSON.parse(facts().x!.facts_json!)).toEqual(sampleX());
    expect(facts().x!.gap_reason).toBeNull();
    // Власникова ситуація 14.09: роль з X як головним джерелом має бал, а не missing_anchor:x.
    expect(scores().bd!.score).toBeGreaterThan(0);
    expect(scores().marketing_content!.score).toBeGreaterThan(0);
    expect(JSON.parse(scores().bd!.breakdown_json).gaps?.x).toBeUndefined();
    expect(summary.selfReported).toEqual(["x", "site", "evm", "solana"]);
  });

  it("лише самозаявлені X і гаманці (без жодного коду) дають бали ролям X і трейдера", async () => {
    db.addIdentity(USER, "x", "alice");
    db.addIdentity(USER, "evm", EVM_A);
    const summary = await scoreUser(USER, { registry: fakeRegistry(), db, env: {}, now: () => NOW });
    const s = scores();
    for (const role of ["bd", "community", "marketing_content", "creator_kol", "product_manager", "trader"]) {
      expect(s[role]!.score, role).toBeGreaterThan(0);
    }
    expect(summary.selfReported).toEqual(["x", "evm"]);
  });

  it("БЕЗПЕКА: непідтверджений GitHub рахується як GitHub, але Sherlock з ним не звіряється", async () => {
    fullIdentities(true, false);
    const registry = fakeRegistry();
    await scoreUser(USER, { registry, db, env: {}, now: () => NOW });
    const inputs = Object.fromEntries(registry.calls.map((c) => [c.collector, c.input]));
    expect(inputs.collectGithub).toBe("alice-gh");
    expect(inputs.collectDune).toBe("alice-gh");
    expect(inputs.collectAudits).toEqual({ sherlock: "alice", github: null, x: "alice" });
    expect(JSON.parse(facts().github!.facts_json!)).toEqual(sampleGithub());
    expect(scores().engineer!.score).toBeGreaterThan(0);
  });

  it("БЕЗПЕКА: ні GitHub, ні X не підтверджені: collectAudits не отримує жодного ніка для звірки", async () => {
    fullIdentities(false, false);
    const registry = fakeRegistry({ collectAudits: async (_h: string, links: { github: string | null; x: string | null }) =>
      (links.github || links.x ? { ok: true, facts: sampleAudits() } : { ok: false, gap: "audits: no GitHub or X to verify the Sherlock profile against" }) });
    await scoreUser(USER, { registry, db, env: {} });
    expect(registry.calls.find((c) => c.collector === "collectAudits")!.input).toEqual({ sherlock: "alice", github: null, x: null });
    expect(facts().audits).toMatchObject({ facts_json: null, gap_reason: expect.stringMatching(/no GitHub or X/) });
    expect(JSON.parse(scores().security_auditor!.breakdown_json).sources.audits).toBeNull();
  });

  it("збирачі отримують межу збору: старт + deadlineMs, і годинник", async () => {
    fullIdentities();
    const registry = fakeRegistry();
    const before = Date.now();
    await scoreUser(USER, { registry, db, env: {}, deadlineMs: 20_000 });
    const after = Date.now();
    expect(registry.calls.length).toBeGreaterThan(5);
    for (const c of registry.calls) {
      expect(c.ctx.deadline).toBeGreaterThanOrEqual(before + 20_000);
      expect(c.ctx.deadline).toBeLessThanOrEqual(after + 20_000);
      expect(typeof c.ctx.now()).toBe("number");
    }
    expect(new Set(registry.calls.map((c) => c.ctx.deadline)).size).toBe(1);
  });

  it("дедлайн: повільні збирачі стають прогалиною 'timeout', отримують abort, а завдання не падає", async () => {
    fullIdentities();
    const registry = fakeRegistry({ collectGithub: hangUntilAborted(), collectSolana: neverResolves() });
    const t0 = performance.now();
    const summary = await scoreUser(USER, { registry, db, env: {}, deadlineMs: 80 });
    expect(performance.now() - t0).toBeLessThan(2_000);

    const f = facts();
    expect(f.github).toMatchObject({ facts_json: null, gap_reason: "timeout" });
    expect(f.solana).toMatchObject({ facts_json: null, gap_reason: "timeout" });
    expect(f.x!.facts_json).not.toBeNull();
    expect(registry.calls.find((c) => c.collector === "collectGithub")!.signal.aborted).toBe(true);
    expect(summary.gaps.sort()).toEqual(["github", "solana"]);
    expect(summary.sources.github!.ms).toBeGreaterThanOrEqual(70);

    const s = scores();
    expect(s.engineer).toMatchObject({ score: null });
    expect(JSON.parse(s.engineer!.breakdown_json).reason).toBe("missing_anchor:gh_eng");
    expect(s.community!.score).not.toBeNull();
  });

  it("виняток або сміття від збирача стає прогалиною, а не нулем і не падінням", async () => {
    db.addIdentity(USER, "github", "alice-gh");
    const registry = fakeRegistry({
      collectGithub: async () => { throw new Error("bug at https://api.github.com/x?token=SECRET"); },
      collectDune: async () => ({ ok: true, facts: null }) as never,
    });
    await scoreUser(USER, { registry, db, env: {} });
    const f = facts();
    expect(f.github!.facts_json).toBeNull();
    expect(f.github!.gap_reason).toMatch(/^error: /);
    expect(f.github!.gap_reason).not.toContain("SECRET");
    expect(f.dune).toMatchObject({ facts_json: null, gap_reason: "invalid collector result" });
  });

  it("часткова відповідь гаманців: факти пишуться, примітки адрес ідуть у gap_reason і breakdown.gaps", async () => {
    db.addIdentity(USER, "evm", EVM_A);
    db.addIdentity(USER, "evm", EVM_B);
    db.addIdentity(USER, "solana", SOL);
    const registry = fakeRegistry({
      collectEvm: async () => ({ ok: true, facts: sampleEvm([EVM_A]), partial: { [EVM_B]: "etherscan: HTTP 502" } }),
      collectSolana: async () => ({ ok: true, facts: sampleSolana([SOL]), partial: { [SOL]: "swaps: not configured: HELIUS_KEY" } }),
    });
    const summary = await scoreUser(USER, { registry, db, env: {} });
    expect(summary.sources.evm).toMatchObject({ partial: 1 });
    expect(summary.sources.evm!.gap).toBeUndefined();
    expect(summary.gaps).toEqual([]);
    const f = facts();
    expect(f.evm).toMatchObject({ gap_reason: "partial: 0xbbbbbb: etherscan: HTTP 502" });
    expect(JSON.parse(f.evm!.facts_json!)).toEqual(sampleEvm([EVM_A]));
    expect(f.solana).toMatchObject({ gap_reason: "partial: So111111: swaps: not configured: HELIUS_KEY" });
    expect(JSON.parse(f.solana!.facts_json!)).toEqual(sampleSolana([SOL]));
    const b = JSON.parse(scores().trader!.breakdown_json);
    expect(b.gaps).toMatchObject({ "evm.0xbbbbbb": "etherscan: HTTP 502", "solana.So111111": "swaps: not configured: HELIUS_KEY" });
    expect(b.sources.trading).not.toBeNull();
  });

  it("часткова відповідь без приміток пише gap_reason = NULL", async () => {
    db.addIdentity(USER, "evm", EVM_A);
    await scoreUser(USER, { registry: fakeRegistry(), db, env: {} });
    expect(facts().evm).toMatchObject({ gap_reason: null });
  });

  it("джерела, яких людина вже не має, прибираються з source_facts", async () => {
    db.addIdentity(USER, "github", "alice-gh");
    db.exec("INSERT INTO source_facts (user_id, source, facts_json) VALUES (?, 'youtube', '{}'), (?, 'x', '{}')", USER, USER);
    await scoreUser(USER, { registry: fakeRegistry(), db, env: {} });
    expect(Object.keys(facts()).sort()).toEqual(["dune", "github"]);

    db.exec("DELETE FROM identities WHERE user_id = ?", USER);
    await scoreUser(USER, { registry: fakeRegistry(), db, env: {} });
    expect(facts()).toEqual({});
    const s = scores();
    expect(Object.keys(s)).toHaveLength(15);
    expect(Object.values(s).every((r) => r.score === null)).toBe(true);
  });

  it("зупинка процесу під час збору: виняток і жодного запису", async () => {
    fullIdentities();
    const stop = new AbortController();
    const registry = fakeRegistry({ collectGithub: hangUntilAborted() });
    setTimeout(() => stop.abort(new DOMException("shutdown", "AbortError")), 20);
    await expect(scoreUser(USER, { registry, db, env: {}, signal: stop.signal, deadlineMs: 10_000 }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(facts()).toEqual({});
    expect(scores()).toEqual({});
  });

  it("збій посеред запису не лишає половини: попередні факти цілі, нових балів немає", async () => {
    db.addIdentity(USER, "x", "alice", true);
    db.exec("INSERT INTO source_facts (user_id, source, facts_json) VALUES (?, 'x', '{\"old\":true}')", USER);
    let n = 0;
    db.beforeStatement = (sql) => { if (sql.startsWith("INSERT INTO scores") && ++n === 5) throw new Error("D1 HTTP 500"); };
    await expect(scoreUser(USER, { registry: fakeRegistry(), db, env: {} })).rejects.toThrow(/500/);
    db.beforeStatement = null;
    expect(facts().x!.facts_json).toBe('{"old":true}');
    expect(scores()).toEqual({});
  });
});

describe("scoreUser: fastFirstPass (п.14, 15.09: перший бал швидше)", () => {
  it("без fastFirstPass кожен збирач зветься раз, зі звичайною вибіркою й дедлайном", async () => {
    fullIdentities();
    const registry = fakeRegistry();
    await scoreUser(USER, { registry, db, env: { OTHER: "kept" }, now: () => NOW });
    const solana = registry.calls.filter((c) => c.collector === "collectSolana");
    expect(solana).toHaveLength(1);
    expect(solana[0]!.ctx.env).toEqual({ OTHER: "kept" });
    expect(registry.calls.filter((c) => c.collector === "collectX")).toHaveLength(1);
  });

  it("з fastFirstPass кожен збирач зветься двічі: спершу мала вибірка Solana й коротший дедлайн, потім звичайні", async () => {
    fullIdentities();
    const registry = fakeRegistry();
    const deadlineMs = 45_000;
    const summary = await scoreUser(USER, { registry, db, env: { OTHER: "kept" }, now: () => NOW, deadlineMs, fastFirstPass: true });

    const solana = registry.calls.filter((c) => c.collector === "collectSolana");
    expect(solana).toHaveLength(2);
    expect(solana[0]!.ctx.env).toEqual({ OTHER: "kept", SOL_SAMPLE: String(FAST_FIRST_PASS_SAMPLE) });
    expect(solana[0]!.ctx.deadline).toBe(NOW + FAST_FIRST_PASS_DEADLINE_MS);
    expect(solana[1]!.ctx.env).toEqual({ OTHER: "kept" }); // другий прохід без вибірки-обмеження
    expect(solana[1]!.ctx.deadline).toBe(NOW + deadlineMs);
    // Решта збирачів теж двічі: другий прохід це повний перерахунок усього, не лише Solana.
    expect(registry.calls.filter((c) => c.collector === "collectX")).toHaveLength(2);

    // Другий, повний прохід лишається джерелом правди в scores (тут ті самі дані з fakeRegistry).
    expect(summary.scored).toBeGreaterThan(0);
    expect(Object.keys(scores()).length).toBeGreaterThan(0);
  });

  it("перший прохід, що впав, не заважає другому записати бал", async () => {
    fullIdentities();
    let solanaCalls = 0;
    const registry = fakeRegistry({
      collectSolana: async () => {
        solanaCalls++;
        if (solanaCalls === 1) throw new Error("RPC boom");
        return { ok: true, facts: sampleSolana([SOL]) };
      },
    });
    const summary = await scoreUser(USER, { registry, db, env: {}, now: () => NOW, fastFirstPass: true });
    expect(solanaCalls).toBe(2);
    expect(summary.scored).toBeGreaterThan(0);
    expect(JSON.parse(facts().solana!.facts_json!)).toEqual(sampleSolana([SOL]));
  });

  it("зупинка процесу під час першого проходу кидає й нічого не пише (не ковтає signal)", async () => {
    fullIdentities();
    const stop = new AbortController();
    const registry = fakeRegistry({ collectSolana: () => hangUntilAborted() });
    const promise = scoreUser(USER, { registry, db, env: {}, signal: stop.signal, fastFirstPass: true, deadlineMs: 10_000 });
    stop.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(scores()).toEqual({});
  });
});

describe("groupIdentities", () => {
  const row = (id: number, kind: IdentityRow["kind"], value: string, verified = false): IdentityRow =>
    ({ id, kind, value, verified_at: verified ? "2026-09-01 00:00:00" : null });

  it("підтверджений X важить більше за раніший непідтверджений; гаманці всі й без повторів", () => {
    const got = groupIdentities([
      row(1, "x", "first"), row(2, "x", "second", true), row(3, "github", "gh"), row(4, "evm", EVM_A),
      row(5, "evm", EVM_B), row(6, "evm", EVM_A), row(7, "solana", SOL), row(8, "youtube", "@chan"), row(9, "site", "https://a.b"),
    ]);
    expect(got).toEqual({ x: { handle: "second", verified: true }, github: { login: "gh", verified: false }, youtube: "@chan",
      site: "https://a.b", evm: [EVM_A, EVM_B], solana: [SOL], sherlock: null });
  });

  it("GitHub: підтверджений важить більше за раніший непідтверджений", () => {
    expect(groupIdentities([row(1, "github", "old"), row(2, "github", "proven", true)]).github).toEqual({ login: "proven", verified: true });
  });

  it("без ідентичностей порожньо", () => {
    expect(groupIdentities([])).toEqual({ x: null, github: null, youtube: null, site: null, evm: [], solana: [], sherlock: null });
  });
});


import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scorePerson } from "../formula/score.js";
import { SqliteD1 } from "../testing/sqlite-d1.js";
import type { PersonFacts } from "../types.js";
import {
  fakeRegistry, hangUntilAborted, neverResolves, sampleAudits, sampleDune, sampleEvm, sampleGithub, sampleHyperliquid,
  sampleSolana, sampleX,
} from "./fake-registry.js";
import { groupIdentities, type IdentityRow } from "./identities.js";
import { createRealRegistry } from "./realRegistry.js";
import { scoreUser } from "./run-person.js";

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

const fullIdentities = (xVerified = true): void => {
  db.addIdentity(USER, "x", "alice", xVerified);
  db.addIdentity(USER, "github", "alice-gh");
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
      expect(s[role]).toMatchObject({ score: rr.score, core: rr.core, cover: rr.cover, formula_version: "v5" });
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

  it("непідтверджений X не збирається: прогалина 'not verified', і профіль Sherlock з ним не звіряється", async () => {
    fullIdentities(false);
    const registry = fakeRegistry();
    await scoreUser(USER, { registry, db, env: {} });
    expect(registry.calls.map((c) => c.collector)).not.toContain("collectX");
    expect(registry.calls.find((c) => c.collector === "collectAudits")!.input).toEqual({ sherlock: "alice", github: "alice-gh", x: null });
    expect(facts().x).toMatchObject({ facts_json: null, gap_reason: "not verified" });
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

  it("часткова відповідь гаманців: факти пишуться, адреси без відповіді видно в підсумку", async () => {
    db.addIdentity(USER, "evm", EVM_A);
    db.addIdentity(USER, "evm", EVM_B);
    const registry = fakeRegistry({
      collectEvm: async () => ({ ok: true, facts: sampleEvm([EVM_A]), partial: { [EVM_B]: "etherscan: HTTP 502" } }),
    });
    const summary = await scoreUser(USER, { registry, db, env: {} });
    expect(summary.sources.evm).toMatchObject({ partial: 1 });
    expect(summary.sources.evm!.gap).toBeUndefined();
    expect(facts().evm).toMatchObject({ gap_reason: null });
    expect(JSON.parse(facts().evm!.facts_json!)).toEqual(sampleEvm([EVM_A]));
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

describe("groupIdentities", () => {
  const row = (id: number, kind: IdentityRow["kind"], value: string, verified = false): IdentityRow =>
    ({ id, kind, value, verified_at: verified ? "2026-09-01 00:00:00" : null });

  it("підтверджений X важить більше за раніший непідтверджений; гаманці всі й без повторів", () => {
    const got = groupIdentities([
      row(1, "x", "first"), row(2, "x", "second", true), row(3, "github", "gh"), row(4, "evm", EVM_A),
      row(5, "evm", EVM_B), row(6, "evm", EVM_A), row(7, "solana", SOL), row(8, "youtube", "@chan"), row(9, "site", "https://a.b"),
    ]);
    expect(got).toEqual({ x: { handle: "second", verified: true }, github: "gh", youtube: "@chan", site: "https://a.b",
      evm: [EVM_A, EVM_B], solana: [SOL], sherlock: null });
  });

  it("без ідентичностей порожньо", () => {
    expect(groupIdentities([])).toEqual({ x: null, github: null, youtube: null, site: null, evm: [], solana: [], sherlock: null });
  });
});

describe("realRegistry", () => {
  it("поки збирачі не під'єднані, відмовляє одразу і ясно", () => {
    expect(() => createRealRegistry()).toThrow(/collectors not wired/);
  });
});

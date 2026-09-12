import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiKey,
  addCompany,
  addFacts,
  addIdentity,
  addMember,
  addScore,
  addSubscription,
  addUser,
  contextFor,
  crmDb,
  CURSOR_SECRET,
  publishFormula,
  run,
  setConsent,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import type { ActionContext } from "./context";
import { loadCandidates } from "./project";
import { filtersHash, openCursor, sealCursor, searchCandidates } from "./search";
import { isVisibleTo } from "./visibility";
import { ActionError, FORMULA_VERSION, type SearchRequest, type SearchResponse } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

const NOW = new Date("2026-09-12T12:00:00Z");

async function companyCtx(): Promise<{ co: string; ctx: ActionContext }> {
  const co = addCompany(db.raw);
  addSubscription(db.raw, co);
  const { key } = await addApiKey(db.raw, co);
  return { co, ctx: await contextFor(db, { authorization: `Bearer ${key}` }, { now: NOW }) };
}

async function guestCtx(): Promise<ActionContext> {
  return contextFor(db, { hasPayment: true }, { now: NOW });
}

const ids = (r: SearchResponse) => r.data.map((d) => d.candidate_id);

async function rejection(p: Promise<unknown>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionError) return e;
    throw e;
  }
  throw new Error("expected an ActionError");
}

/** Видимий кандидат з балом ролі engineer. */
function candidate(score: number | null, o: Parameters<typeof addUser>[1] = {}, cover = 100): string {
  const id = addUser(db.raw, o);
  if (score !== undefined) addScore(db.raw, id, "engineer", score, { cover });
  return id;
}

describe("who appears", () => {
  it("only people with the visibility flag AND a granted visibility consent", async () => {
    const { ctx } = await companyCtx();
    const shown = candidate(60);
    candidate(90, { visible: false });
    candidate(80, { visible: true, consent: false });
    const flagOff = candidate(70, { visible: false, consent: true });
    const res = await searchCandidates(ctx, { filters: { role: "engineer" } });
    expect(ids(res)).toEqual([shown]);
    expect(ids(res)).not.toContain(flagOff);
  });

  it("a revoked consent makes the candidate disappear at once", async () => {
    const { ctx } = await companyCtx();
    const id = candidate(60);
    expect(ids(await searchCandidates(ctx, {}))).toEqual([id]);
    setConsent(db.raw, id, "visibility", false);
    const after = await searchCandidates(ctx, {});
    expect(after.data).toEqual([]);
    expect(after.empty_reason).toBe("no_visible_candidates_for_role");
  });

  it("a candidate who blocked a company is hidden from that company only", async () => {
    const a = await companyCtx();
    const b = await companyCtx();
    const id = candidate(60);
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, candidate_blocked)
       VALUES ('int_AAAAAAAAAAAAAAAAAAAA', ?, ?, 'approval', 'declined', 'We would love to talk about a role.', 'rest', datetime('now', '+14 days'), 1)`,
      a.co,
      id,
    );
    expect(ids(await searchCandidates(a.ctx, {}))).toEqual([]);
    expect(ids(await searchCandidates(b.ctx, {}))).toEqual([id]);
    expect(ids(await searchCandidates(await guestCtx(), {}))).toEqual([id]);
  });

  it("team members do not see themselves in their own company's search", async () => {
    const a = await companyCtx();
    const b = await companyCtx();
    const teammate = candidate(60);
    addMember(db.raw, a.co, teammate, "member");
    expect(ids(await searchCandidates(a.ctx, {}))).toEqual([]);
    expect(ids(await searchCandidates(b.ctx, {}))).toEqual([teammate]);
  });

  it("only for roles the person chose, even when a score exists for another role", async () => {
    const { ctx } = await companyCtx();
    const id = addUser(db.raw, { roles: ["devrel"] });
    addScore(db.raw, id, "engineer", 90);
    addScore(db.raw, id, "devrel", 40);
    expect(ids(await searchCandidates(ctx, { filters: { role: "engineer" } }))).toEqual([]);
    const devrel = await searchCandidates(ctx, { filters: { role: "devrel" } });
    expect(ids(devrel)).toEqual([id]);
    expect(devrel.data[0].roles.map((r) => r.role)).toEqual(["devrel"]);
  });

  it("only people with at least one known role are visible", async () => {
    const { co, ctx } = await companyCtx();
    const none = addUser(db.raw, { roles: [] });
    const junk = addUser(db.raw, { rolesJson: JSON.stringify(["@alice", "ceo"]) });
    const ok = candidate(50);
    expect(ids(await searchCandidates(ctx, {}))).toEqual([ok]);
    expect(await isVisibleTo(db.d1, none, co)).toBe(false);
    expect(await isVisibleTo(db.d1, junk, null)).toBe(false);
    expect(await isVisibleTo(db.d1, ok, co)).toBe(true);
  });

  it("loadCandidates itself never returns an invisible person, whatever id it is given", async () => {
    const { co } = await companyCtx();
    const hidden = candidate(50, { visible: false });
    const teammate = candidate(50);
    addMember(db.raw, co, teammate, "member");
    const shown = candidate(40);
    const rows = await loadCandidates(db.d1, [hidden, teammate, shown], co);
    expect([...rows.keys()]).toEqual([shown]);
  });

  it("broken roles JSON in one row does not break the search for everyone", async () => {
    const { ctx } = await companyCtx();
    candidate(null, { rolesJson: "not json" });
    const ok = candidate(50);
    expect(ids(await searchCandidates(ctx, {}))).toEqual([ok]);
    expect(ids(await searchCandidates(ctx, { filters: { role: "engineer" } }))).toEqual([ok]);
  });
});

describe("sorting and levels", () => {
  it("sorts by score with unscored and pending candidates last, ties by id", async () => {
    const { ctx } = await companyCtx();
    const unscored = candidate(null);
    const pending = addUser(db.raw); // обрав роль, балу ще немає
    const low = candidate(12.5);
    const high = candidate(88.2);
    const tieA = candidate(50);
    const tieB = candidate(50);
    const res = await searchCandidates(ctx, { filters: { role: "engineer" } });
    const tie = [tieA, tieB].sort();
    const tail = [unscored, pending].sort();
    expect(ids(res)).toEqual([high, ...tie, low, ...tail]);
    expect(res.data.at(-1)?.headline.unscored_reason).toMatch(/missing_anchor|pending/);
  });

  it.each(["level", "coverage", "newest"] as const)("sort=%s also puts unscored candidates after scored ones", async (sort) => {
    const { ctx } = await companyCtx();
    const unscored = candidate(null, { consentAt: "2026-09-12 11:00:00" }, 100);
    const scored = candidate(30, { consentAt: "2026-01-01 00:00:00" }, 20);
    const res = await searchCandidates(ctx, { filters: { role: "engineer" }, sort });
    expect(ids(res)).toEqual([scored, unscored]);
  });

  it("level sort breaks level ties by coverage; newest sorts by when visibility was granted", async () => {
    const { ctx } = await companyCtx();
    const l7low = candidate(61, { consentAt: "2026-09-01 00:00:00" }, 40);
    const l7high = candidate(65, { consentAt: "2026-08-01 00:00:00" }, 90);
    const l8 = candidate(71, { consentAt: "2026-07-01 00:00:00" }, 10);
    expect(ids(await searchCandidates(ctx, { sort: "level" }))).toEqual([l8, l7high, l7low]);
    expect(ids(await searchCandidates(ctx, { sort: "newest" }))).toEqual([l7low, l7high, l8]);
    expect(ids(await searchCandidates(ctx, { sort: "coverage" }))).toEqual([l7high, l7low, l8]);
  });

  it("min_level L keeps scores from 10(L-1) up and drops unscored; max_level caps below 10L", async () => {
    const { ctx } = await companyCtx();
    candidate(null);
    const s59 = candidate(59.9);
    const s60 = candidate(60);
    const s79 = candidate(79.99);
    const s80 = candidate(80);
    const byLevel = (f: SearchRequest["filters"]) => searchCandidates(ctx, { filters: { role: "engineer", ...f } }).then(ids);
    expect(await byLevel({ min_level: 7 })).toEqual([s80, s79, s60]);
    expect(await byLevel({ min_level: 7, max_level: 8 })).toEqual([s79, s60]);
    expect(await byLevel({ max_level: 6 })).toEqual([s59]);
    expect(await byLevel({ min_level: 10 })).toEqual([]);
    const shown = await searchCandidates(ctx, { filters: { min_level: 8 } });
    expect(shown.data.map((d) => [d.headline.score, d.headline.level])).toEqual([[80, 9], [79, 8]]);
  });

  it("scores of an unpublished formula are not shown, and a score filter explains why nothing came back", async () => {
    const { ctx } = await companyCtx();
    run(db.raw, "DELETE FROM quality_runs");
    publishFormula(db.raw, FORMULA_VERSION, false); // прогін воріт був, але не пройшов
    const id = addUser(db.raw);
    addScore(db.raw, id, "engineer", 75);
    const res = await searchCandidates(ctx, { filters: { role: "engineer" } });
    expect(res.data[0].headline).toEqual({ role: "engineer", score: null, level: null, coverage: null, unscored_reason: "not_published" });
    const filtered = await searchCandidates(ctx, { filters: { role: "engineer", min_score: 10 } });
    expect(filtered).toMatchObject({ data: [], empty_reason: "scores_not_published", role_visible_count: 1 });
  });
});

describe("filters", () => {
  it("chains (any of) and onchain years come from source facts", async () => {
    const { ctx } = await companyCtx();
    const base = addUser(db.raw);
    addScore(db.raw, base, "engineer", 50);
    addFacts(db.raw, base, "evm", { "0x1111111111111111111111111111111111111111": { base: { sent: 3, firstTs: null, sentCapped: false, swaps: 0, source: "blockscout" } } });
    const sol = addUser(db.raw);
    addScore(db.raw, sol, "engineer", 40);
    const fiveYearsAgo = NOW.getTime() / 1000 - 5 * 365.25 * 86400;
    addFacts(db.raw, sol, "solana", { So1: { sigs: 10, sigsOk: 10, sigsCapped: false, firstTs: fiveYearsAgo, sampleSeen: 10, sampleSwaps: 0, swaps: null } });
    const none = addUser(db.raw);
    addScore(db.raw, none, "engineer", 90);

    expect(ids(await searchCandidates(ctx, { filters: { chains: ["base", "hyperliquid"] } }))).toEqual([base]);
    expect(ids(await searchCandidates(ctx, { filters: { chains: ["solana", "base"] } }))).toEqual([base, sol]);
    expect(ids(await searchCandidates(ctx, { filters: { min_onchain_years: 4 } }))).toEqual([sol]);
    expect(ids(await searchCandidates(ctx, { filters: { min_onchain_years: 6 } }))).toEqual([]);
    const all = await searchCandidates(ctx, {});
    expect(all.data.find((d) => d.candidate_id === sol)).toMatchObject({ chains: ["solana"], onchain_years: 4 });
  });

  it("remote or an exact city (any letter case), verified X and wallets, direct contact", async () => {
    const { ctx } = await companyCtx();
    const remote = candidate(50, { remoteMode: "remote" });
    const lisbon = candidate(40, { remoteMode: "remote,city", city: "Lisbon" });
    const paris = candidate(30, { remoteMode: "city", city: "Paris" });
    addIdentity(db.raw, paris, "x", "paris_dev", { via: "bio_code", verified: true });
    addIdentity(db.raw, lisbon, "evm", "0x2222222222222222222222222222222222222222", { via: "signature", verified: true });
    addIdentity(db.raw, remote, "evm", "0x3333333333333333333333333333333333333333");
    const direct = candidate(20, { contactMode: "direct", telegram: "direct_dev", contactConsent: true });
    candidate(10, { contactMode: "direct", telegram: "no_consent_dev" });

    const q = (filters: SearchRequest["filters"]) => searchCandidates(ctx, { filters }).then(ids);
    expect(await q({ work_mode: "remote" })).toEqual(expect.arrayContaining([remote, lisbon]));
    expect(await q({ work_mode: "remote" })).not.toContain(paris);
    expect(await q({ work_mode: "city", city: " lisbon " })).toEqual([lisbon]);
    expect(await q({ work_mode: "city", city: "LISBON" })).toEqual([lisbon]);
    expect(await q({ x_verified: true })).toEqual([paris]);
    expect(await q({ wallet_verified: true })).toEqual([lisbon]);
    expect(await q({ contact_direct: true })).toEqual([direct]);
  });

  it("exclude_in_pipeline hides candidates already on this company's board", async () => {
    const { co, ctx } = await companyCtx();
    const a = candidate(50);
    const b = candidate(40);
    run(db.raw, "INSERT INTO pipeline (company_id, user_id, added_via) VALUES (?, ?, 'rest')", co, a);
    expect(ids(await searchCandidates(ctx, { filters: { exclude_in_pipeline: true } }))).toEqual([b]);
    const res = await searchCandidates(ctx, {});
    expect(res.data.map((d) => d.pipeline)).toEqual([{ stage: "found", tags: [] }, null]);
  });
});

describe("city in any alphabet", () => {
  it("matches a non-Latin city without regard to letter case or Unicode form", async () => {
    const { ctx } = await companyCtx();
    const kyiv = candidate(50, { remoteMode: "city", city: "Київ" });
    const krakow = candidate(40, { remoteMode: "city", city: "Krako\u0301w" }); // «ó» розкладено на o + наголос
    candidate(30, { remoteMode: "city", city: "Kyiv" });
    const q = (city: string) => searchCandidates(ctx, { filters: { work_mode: "city", city } }).then(ids);
    expect(await q("КИЇВ")).toEqual([kyiv]);
    expect(await q(" київ ")).toEqual([kyiv]);
    expect(await q("KRAKÓW")).toEqual([krakow]);
  });
});

describe("empty results always say why", () => {
  it("no visible candidates for the role", async () => {
    const { ctx } = await companyCtx();
    candidate(50);
    const res = await searchCandidates(ctx, { filters: { role: "trader" } });
    expect(res).toMatchObject({ data: [], page: 1, next_cursor: null, empty_reason: "no_visible_candidates_for_role", role_visible_count: 0 });
  });

  it("filters too narrow, with how many chose the role", async () => {
    const { ctx } = await companyCtx();
    candidate(50);
    candidate(55);
    const res = await searchCandidates(ctx, { filters: { role: "engineer", min_score: 90 } });
    expect(res).toMatchObject({ data: [], empty_reason: "filters_too_narrow", role_visible_count: 2 });
  });

  it("the current formula comes from the contract, the same constant as the engine's", () => {
    const engine = readFileSync(new URL("../../../../engine/src/formula/score.ts", import.meta.url), "utf8");
    expect(engine).toContain(`export const FORMULA_VERSION = "${FORMULA_VERSION}"`);
  });

  it("a non-empty page has no empty_reason", async () => {
    const { ctx } = await companyCtx();
    candidate(50);
    expect(await searchCandidates(ctx, {})).toMatchObject({ empty_reason: null, role_visible_count: null });
  });
});

describe("pagination", () => {
  function many(n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(candidate(i % 7 === 0 ? null : (i * 37) % 100));
    return out;
  }

  it("20 per page, stable order, no repeats, next_cursor null at the end", async () => {
    const { ctx } = await companyCtx();
    const everyone = many(45);
    const seen: string[] = [];
    let cursor: string | undefined;
    const pages: number[] = [];
    do {
      const res = await searchCandidates(ctx, { cursor });
      pages.push(res.page);
      seen.push(...ids(res));
      cursor = res.next_cursor ?? undefined;
    } while (cursor);
    expect(pages).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(45);
    expect(new Set(seen)).toEqual(new Set(everyone));
    const first = await searchCandidates(ctx, {});
    expect(ids(first)).toEqual(seen.slice(0, 20));
  });

  it("stops after 10 pages: page 10 says page_cap_reached, a page 11 cursor gets 409", async () => {
    const { ctx } = await companyCtx();
    many(215);
    let res = await searchCandidates(ctx, {});
    for (let page = 2; page <= 10; page++) {
      expect(res.page_cap_reached).toBe(false);
      res = await searchCandidates(ctx, { cursor: res.next_cursor! });
    }
    expect(res).toMatchObject({ page: 10, next_cursor: null, page_cap_reached: true });
    expect(res.data).toHaveLength(20);

    const last = res.data.at(-1)!;
    const eleven = await sealCursor(
      {
        v: 2,
        sort: "score",
        fh: await filtersHash({}, "score"),
        page: 11,
        a: { k: last.headline.score ?? -1, id: last.candidate_id },
        skip: 0,
      },
      CURSOR_SECRET,
    );
    expect(await rejection(searchCandidates(ctx, { cursor: eleven }))).toMatchObject({ code: "page_cap_reached", status: 409 });
  });

  it("the cursor is encrypted: no score, no candidate id, and a changed byte is rejected", async () => {
    const { ctx } = await companyCtx();
    const scores = [73.91, 64.37, 55.28];
    for (let i = 0; i < 25; i++) candidate(scores[i % 3] - i / 100);
    const first = await searchCandidates(ctx, {});
    const cursor = first.next_cursor!;
    const last = first.data.at(-1)!;
    const bytes = Buffer.from(cursor, "base64url");
    const text = bytes.toString("latin1");
    // Лише маркери, які випадкові байти не дадуть: id (32+ символи), бали з крапкою
    // (крапки й лапок немає в base64url) і ключі відкритого JSON курсору. Двосимвольне
    // "73" траплялось у шифротексті випадково (флейк 1 з ~20).
    const leaks = [
      last.candidate_id,
      last.candidate_id.replace(/-/g, ""),
      ...scores.map(String),
      '"k":',
      '"id":"',
      '"sort":"score"',
      '"page":2',
    ];
    for (const leak of leaks) {
      expect(cursor).not.toContain(leak);
      expect(text).not.toContain(leak);
    }
    expect(() => JSON.parse(text)).toThrow();
    // Два курсори тієї самої позиції різні (випадковий IV).
    expect((await searchCandidates(ctx, {})).next_cursor).not.toBe(cursor);

    for (const i of [0, 5, 20, bytes.length - 1]) {
      const tampered = Buffer.from(bytes);
      tampered[i] ^= 0x01;
      expect(await rejection(searchCandidates(ctx, { cursor: tampered.toString("base64url") }))).toMatchObject({
        code: "validation_failed",
        status: 422,
      });
    }
    expect(await rejection(searchCandidates(ctx, { cursor: cursor.slice(0, 20) }))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(searchCandidates(ctx, { cursor, filters: { min_score: 1 } }))).toMatchObject({ code: "validation_failed" });
    expect(await rejection(searchCandidates(ctx, { cursor, sort: "newest" }))).toMatchObject({ code: "validation_failed" });
    // Інший секрет не відкриє курсор.
    await expect(openCursor(cursor, "another-secret-another-secret-another", "score", await filtersHash({}, "score"))).rejects.toMatchObject({
      code: "validation_failed",
    });
    // Усередині: якір = останній відданий кандидат.
    const inside = await openCursor(cursor, CURSOR_SECRET, "score", await filtersHash({}, "score"));
    expect(inside).toMatchObject({ page: 2, a: { id: last.candidate_id }, skip: 0 });
  });

  it("after 2 000 non-matching rows the cursor holds no id of a candidate who did not match, and no empty_reason is given", async () => {
    const { ctx } = await companyCtx();
    const insert = db.raw.prepare(
      "INSERT INTO users (id, email, roles, visible_to_companies, remote_mode) VALUES (?, ?, '[\"engineer\"]', 1, 'remote')",
    );
    const consent = db.raw.prepare("INSERT INTO consents (user_id, kind, granted, text_version) VALUES (?, 'visibility', 1, 'v1')");
    const score = db.raw.prepare(
      "INSERT INTO scores (user_id, role, score, cover, breakdown_json, formula_version) VALUES (?, 'engineer', ?, 100, '{}', 'v5')",
    );
    for (let i = 0; i < 2010; i++) {
      const id = crypto.randomUUID();
      insert.run(id, `${id}@example.com`);
      consent.run(id);
      score.run(id, 90 - i / 100);
    }
    const onBase = candidate(1); // найнижчий бал: знайдеться лише після 2 000 переглянутих
    addFacts(db.raw, onBase, "evm", { "0x5555555555555555555555555555555555555555": { base: { sent: 1, firstTs: null } } });

    const filters = { chains: ["base" as const] };
    const first = await searchCandidates(ctx, { filters });
    expect(first).toMatchObject({ data: [], page: 1, empty_reason: null, role_visible_count: null });
    expect(first.next_cursor).not.toBeNull();
    const inside = await openCursor(first.next_cursor!, CURSOR_SECRET, "score", await filtersHash(filters, "score"));
    expect(inside).toEqual({ v: 2, sort: "score", fh: expect.any(String), page: 2, a: null, skip: 2000 });

    const second = await searchCandidates(ctx, { filters, cursor: first.next_cursor! });
    expect(ids(second)).toEqual([onBase]);
    expect(second.next_cursor).toBeNull();
  });
});

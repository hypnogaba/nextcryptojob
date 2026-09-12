import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiKey,
  addCompany,
  addFacts,
  addIdentity,
  addScore,
  addSubscription,
  addUser,
  contextFor,
  crmDb,
  publishFormula,
  run,
  setConsent,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import type { ActionContext } from "./context";
import { breakdownOf, deriveChains, onchainYears, safeCity, type FactRow, type ScoreRow } from "./project";
import { searchCandidates } from "./search";
import { CandidateView, SearchResponse, type CandidateProfile } from "./types";

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

// ---------------------------------------------------------------------------
// Особисті дані: жодних адрес, ніків, пошт у відповіді

const EVM = /0x[0-9a-f]{40}/i;
const BASE58 = /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HANDLE = /(?<![A-Za-z0-9])@[A-Za-z0-9_]{2,}/;

const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const LEAKS = new Set<string>(["not configured: HELIUS_KEY", "secret target text"]);

/** Кандидат, у кожному текстовому полі якого лежить нік, пошта або адреса. n робить значення унікальними. */
function leakyCandidate(n = 0): string {
  const WALLET = `0xAbCdEf0123456789aBcDeF0123456789AbCdEf0${n}`;
  const sol = SOL.slice(0, -1) + "ABCDEFGH"[n];
  const handle = `alice_eth${n}`;
  const email = `alice${n}@example.org`;
  const yt = `UCabcdefghijklmnopqrstu${n}`;
  const site = `https://alice${n}.dev`;
  for (const v of [WALLET, WALLET.toLowerCase(), sol, sol.slice(0, 8), handle, `@${handle}`, email, `t.me/${handle}`, yt, site]) {
    LEAKS.add(v);
  }

  const id = addUser(db.raw, {
    email,
    telegram: handle,
    roles: ["engineer", "security_auditor", `@${handle}`, sol],
    remoteMode: "remote,city",
    city: `@${handle} ${email}`,
    salaryMin: 90000,
    salaryCurrency: sol,
    targetText: `secret target text @${handle} ${email} ${WALLET}`,
    contactMode: "approval",
  });
  addScore(db.raw, id, "engineer", 72.4, {
    breakdown: {
      formula: "v5",
      sources: { gh_eng: 70, x: 60, [WALLET]: 99 },
      core: { gh_eng: { weight: 80, value: 70.2, handle: `@${handle}` }, x: { weight: 20, value: 60 }, [sol]: { weight: 1, value: 1 } },
      bonus: { onchain: { max: 5, value: 90, address: WALLET } },
      cover: 100,
      level: 8,
      reason: `path:gh_eng+x ${email}`,
      gaps: {
        solana: "not configured: HELIUS_KEY",
        [`evm:${WALLET}`]: "timeout",
        [`@${handle}`]: "x",
        [`solana.${sol.slice(0, 8)}`]: `partial: ${sol.slice(0, 8)}: timeout`,
        [`evm.${WALLET.slice(0, 8)}`]: "partial",
      },
      extra: { email },
    },
  });
  addScore(db.raw, id, "security_auditor", null, {
    breakdown: { reason: `missing_anchor:audits,gh_eng ${WALLET}`, gaps: {}, core: {}, bonus: {} },
  });
  addIdentity(db.raw, id, "x", handle, { via: "bio_code", verified: true });
  addIdentity(db.raw, id, "github", `alice-eth${n}`);
  addIdentity(db.raw, id, "youtube", yt);
  addIdentity(db.raw, id, "site", site);
  addIdentity(db.raw, id, "evm", WALLET.toLowerCase(), { via: "signature", verified: true });
  addIdentity(db.raw, id, "solana", sol);
  addIdentity(db.raw, id, "sherlock", handle, { via: "profile_link", verified: true });
  addFacts(db.raw, id, "evm", { [WALLET.toLowerCase()]: { ethereum: { sent: 5, sentCapped: false, firstTs: 1500000000, swaps: 1, source: "etherscan" } } });
  addFacts(db.raw, id, "solana", { [sol]: { sigs: 3, sigsOk: 3, sigsCapped: false, firstTs: 1600000000, sampleSeen: 3, sampleSwaps: 0, swaps: null } });
  addFacts(db.raw, id, "hyperliquid", { [WALLET.toLowerCase()]: { volumeUsd: 1000, fillsRecent: 2 } });
  addFacts(db.raw, id, "x", { followers: 1234, handle });
  addFacts(db.raw, id, "github", { login: `alice-eth${n}`, email });
  return id;
}

function assertNoPii(value: unknown): void {
  const json = JSON.stringify(value);
  for (const leak of LEAKS) expect(json).not.toContain(leak);
  for (const pattern of [EVM, BASE58, EMAIL, HANDLE]) expect(json).not.toMatch(pattern);
}

const SUMMARY_KEYS = new Set([
  "candidate_id", "visibility", "label", "headline", "roles", "work", "salary_floor", "chains", "onchain_years",
  "badges", "contact_mode", "pipeline",
  "role", "score", "level", "coverage", "unscored_reason",
  "modes", "city", "amount", "currency",
  "x_verified", "wallet", "github_linked", "youtube_linked", "site_linked",
  "stage", "tags",
]);
const PROFILE_KEYS = new Set([
  ...SUMMARY_KEYS,
  "roles_detailed", "breakdown", "core", "bonus", "gaps", "formula_version", "updated_at", "source", "label", "weight",
  "value", "max", "intro", "contact",
]);
const RESPONSE_KEYS = new Set(["data", "next_cursor", "page", "page_cap_reached", "empty_reason", "role_visible_count"]);

/** Усі ключі об'єктів у відповіді (рекурсивно). */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("anonymous projection never leaks personal data", () => {
  it("search results carry only whitelisted fields and no handle, email or address", async () => {
    const { ctx } = await companyCtx();
    for (let i = 0; i < 3; i++) leakyCandidate(i);
    const guest = await contextFor(db, { hasPayment: true }, { now: NOW });

    for (const c of [ctx, guest]) {
      for (const filters of [{}, { role: "engineer" as const }, { role: "security_auditor" as const }]) {
        const res = await searchCandidates(c, { filters });
        expect(res.data).toHaveLength(3);
        assertNoPii(res);
        for (const k of keysOf(res)) expect(RESPONSE_KEYS.has(k) || SUMMARY_KEYS.has(k)).toBe(true);
        expect(SearchResponse.safeParse(res).success).toBe(true);
      }
    }
  });

  it("the full profile (with breakdown) leaks nothing either", async () => {
    const { ctx } = await companyCtx();
    const id = leakyCandidate();
    const res = await runAction("get_candidate", { candidate_id: id }, ctx);
    const profile = res.output as CandidateProfile;
    assertNoPii(profile);
    for (const k of keysOf(profile)) expect(PROFILE_KEYS.has(k)).toBe(true);
    expect(CandidateView.safeParse(profile).success).toBe(true);

    // Що саме видно замість сирих даних.
    expect(profile.roles.map((r) => r.role)).toEqual(["engineer", "security_auditor"]);
    expect(profile.headline).toEqual({ role: "engineer", score: 72, level: 8, coverage: 100, unscored_reason: null });
    expect(profile.work).toEqual({ modes: ["remote", "city"], city: null });
    expect(profile.salary_floor).toBeNull();
    expect(profile.chains).toEqual(["ethereum", "solana", "hyperliquid"]);
    expect(profile.onchain_years).toBe(6);
    expect(profile.badges).toEqual({ x_verified: true, wallet: "signature_verified", github_linked: true, youtube_linked: true, site_linked: true });
    expect(profile.contact).toBeNull();
    const engineer = profile.roles_detailed.find((r) => r.role === "engineer")!;
    expect(engineer.breakdown?.core).toEqual([
      { source: "gh_eng", label: "Open-source engineering (GitHub)", weight: 80, value: 70 },
      { source: "x", label: "Reach and engagement on X", weight: 20, value: 60 },
    ]);
    expect(engineer.breakdown?.gaps).toEqual([
      { source: "solana", label: "Solana data unavailable right now" },
      { source: "evm", label: "EVM wallet data unavailable right now" },
    ]);
    expect(profile.roles_detailed.find((r) => r.role === "security_auditor")).toMatchObject({
      unscored_reason: "missing_anchor",
    });
  });
});

describe("get_candidate", () => {
  it("returns hidden with notes kept when a pipeline candidate turns visibility off, 404 otherwise", async () => {
    const { co, ctx } = await companyCtx();
    const id = addUser(db.raw, { telegram: "bob_tg" });
    addScore(db.raw, id, "engineer", 55);
    const stranger = addUser(db.raw);
    run(db.raw, `INSERT INTO pipeline (company_id, user_id, stage, tags, added_via) VALUES (?, ?, 'contact_shared', '["solidity"]', 'rest')`, co, id);
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, responded_at, contact_kind, contact_value)
       VALUES ('int_BBBBBBBBBBBBBBBBBBBB', ?, ?, 'approval', 'accepted', 'We would love to talk about a role.', 'rest',
               '2026-09-26 10:00:00', '2026-09-12 10:00:00', 'telegram', '@bob_tg')`,
      co,
      id,
    );

    const visible = (await runAction("get_candidate", { candidate_id: id }, ctx)).output as CandidateProfile;
    expect(visible.visibility).toBe("visible");
    expect(visible.contact).toEqual({ kind: "telegram", value: "@bob_tg", shared_at: "2026-09-12T10:00:00Z", via: "intro" });
    expect(visible.intro).toMatchObject({ intro_id: "int_BBBBBBBBBBBBBBBBBBBB", status: "accepted", candidate_id: id });

    setConsent(db.raw, id, "visibility", false);
    const hidden = (await runAction("get_candidate", { candidate_id: id }, ctx)).output;
    expect(hidden).toEqual({
      candidate_id: id,
      visibility: "hidden",
      label: `#${id.slice(0, 6).toUpperCase()}`,
      notice: "Candidate is no longer visible",
      pipeline: { stage: "contact_shared", tags: ["solidity"] },
      contact: { kind: "telegram", value: "@bob_tg", shared_at: "2026-09-12T10:00:00Z", via: "intro" },
    });

    setConsent(db.raw, stranger, "visibility", false);
    await expect(runAction("get_candidate", { candidate_id: stranger }, ctx)).rejects.toMatchObject({
      code: "candidate_not_available",
      status: 404,
    });
    await expect(runAction("get_candidate", { candidate_id: crypto.randomUUID() }, ctx)).rejects.toMatchObject({
      code: "candidate_not_available",
    });
  });

  it("a guest cannot open profiles (key_required)", async () => {
    const id = addUser(db.raw);
    const guest = await contextFor(db, { hasPayment: true }, { now: NOW });
    await expect(runAction("get_candidate", { candidate_id: id }, guest)).rejects.toMatchObject({ code: "key_required", status: 401 });
  });
});

// ---------------------------------------------------------------------------
// Дрібні правила проєкції

describe("projection rules", () => {
  const facts = (rows: Record<string, unknown>): FactRow[] =>
    Object.entries(rows).map(([source, f]) => ({ user_id: "u", source, facts_json: JSON.stringify(f) }));

  it("an EVM chain is active with sends or a first transaction; Solana with signatures; Hyperliquid with fills or volume", () => {
    expect(
      deriveChains(
        facts({
          evm: { a: { ethereum: { sent: 0, firstTs: 1600000000 }, base: { sent: 0, firstTs: null }, optimism: { sent: 2, firstTs: null } } },
          solana: { s: { sigs: 0, firstTs: null } },
          hyperliquid: { h: { fillsRecent: 0, volumeUsd: 10 } },
        }),
      ),
    ).toEqual(["ethereum", "optimism", "hyperliquid"]);
    expect(deriveChains([])).toEqual([]);
    expect(deriveChains([{ user_id: "u", source: "evm", facts_json: "not json" }])).toEqual([]);
  });

  it("onchain years round down to 0/1/2/4/6 and skip capped Solana histories", () => {
    const yearsAgo = (y: number) => NOW.getTime() / 1000 - y * 365.25 * 86400;
    const at = (y: number) => onchainYears(facts({ evm: { a: { base: { sent: 1, firstTs: yearsAgo(y) } } } }), NOW);
    expect([0.5, 1, 3.9, 4, 5.99, 7].map(at)).toEqual([0, 1, 2, 4, 4, 6]);
    expect(onchainYears(facts({ solana: { s: { sigs: 9, sigsCapped: true, firstTs: yearsAgo(3) } } }), NOW)).toBeNull();
    expect(onchainYears([], NOW)).toBeNull();
  });

  it("the city is shown only when it looks like a city name", () => {
    expect(safeCity("  São Paulo ")).toBe("São Paulo");
    expect(safeCity("Kyiv")).toBe("Kyiv");
    expect(safeCity("Київ")).toBe("Київ");
    expect(safeCity("N'Djamena")).toBe("N'Djamena");
    for (const bad of ["@alice", "alice_eth", "a@b.co", "t.me/x", "0x1234", SOL, "https://x.com", "Paris 75011", ""]) {
      expect(safeCity(bad)).toBeNull();
    }
  });

  it("breakdown shows source scores and generic gap labels of this role's sources only, never internal reasons", () => {
    const row: ScoreRow = {
      user_id: "u",
      role: "security_auditor",
      score: 81,
      cover: 100,
      formula_version: "v5",
      computed_at: "2026-09-12 09:00:00",
      formula_published: 1,
      breakdown_json: JSON.stringify({
        core: { audits: { weight: 60, value: 88.6 }, gh_eng: { weight: 25, value: null }, nonsense: { weight: 1, value: 1 } },
        bonus: { site: { max: 5, value: 12.4 } },
        gaps: {
          "evm.base": "HTTP 500 from blockscout", // живить onchain, якого в цій ролі немає
          github: "not configured: GITHUB_TOKEN",
          youtube: "quota", // не входить у бал аудитора
          site: "timeout",
          "dune:x": "?",
        },
        reason: "path:audits",
      }),
    };
    expect(breakdownOf(row)).toEqual({
      core: [
        { source: "audits", label: "Audit contest results (Sherlock)", weight: 60, value: 89 },
        { source: "gh_eng", label: "Open-source engineering (GitHub)", weight: 25, value: null },
      ],
      bonus: [{ source: "site", label: "Personal site or blog", max: 5, value: 12 }],
      gaps: [
        { source: "github", label: "GitHub data unavailable right now" },
        { source: "site", label: "Site data unavailable right now" },
      ],
      formula_version: "v5",
      updated_at: "2026-09-12T09:00:00Z",
    });
    // Той самий збій EVM видно в ролі, де є onchain.
    const trader = breakdownOf({
      ...row,
      role: "trader",
      breakdown_json: JSON.stringify({
        core: { trading: { weight: 80, value: 40 }, onchain: { weight: 20, value: 50 } },
        bonus: { x: { max: 5, value: 1 } },
        gaps: { "evm.base": "HTTP 500", youtube: "quota" },
      }),
    });
    expect(trader.gaps).toEqual([{ source: "evm.base", label: "Base data unavailable right now" }]);

    // Часткова прогалина гаманця (contracts §3) несе початок адреси: назовні лише назва джерела.
    const partial = breakdownOf({
      ...row,
      role: "trader",
      breakdown_json: JSON.stringify({
        core: { trading: { weight: 80, value: 40 } },
        bonus: {},
        gaps: { "solana.BGjMfx5B": "partial: BGjMfx5B: timeout", "evm.0xAbCdEf": "partial", "hyperliquid.0x12345678": "x" },
      }),
    });
    expect(partial.gaps).toEqual([
      { source: "solana", label: "Solana data unavailable right now" },
      { source: "evm", label: "EVM wallet data unavailable right now" },
      { source: "hyperliquid", label: "Hyperliquid data unavailable right now" },
    ]);
    expect(JSON.stringify(partial)).not.toMatch(/BGjMfx5B|0xAbCdEf|0x12345678/);
  });
});

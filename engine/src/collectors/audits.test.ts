import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectAudits, normHandle, SHERLOCK_PAUSE_MS, summarizeResume } from "./audits.js";
import { ctxWith, json, mockFetch } from "./testkit.js";

// Синтетичні відповіді Sherlock у формі справжніх (/watson/<h>, /stats/resume/<h>).
const WATSON = {
  handle: "test_auditor", bio: "security researcher", title: "Test Auditor",
  github_handle: "Test-Dev", discord_handle: "test_auditor", twitter_handle: "https://x.com/Test_X/",
  twitter_image: null, avatar_url: null, banner_url: null, profile_contact_button_visible: true,
  certifications: [], senior: false,
};
const contest = (provider: string, payout: number | null, severities: string[]) => ({
  coin: "USDC", date: 1747684800, url: "https://example.org/contest", handle: "test_auditor", logo_url: null,
  payout, private: false, ranking: 3, title: `${provider} contest`, type: "CONTEST", provider,
  issues: severities.map((severity) => ({ title: null, severity, visibility: "NOT_PUBLISHED", url: null })),
});
const RESUME = [
  contest("SHERLOCK", 1000.5, ["HIGH", "MEDIUM"]),
  contest("CODE4RENA", 2500.25, ["HIGH", "HIGH", "CRITICAL", "MEDIUM"]),
  contest("CODE4RENA", 0, []),
  { ...contest("SHERLOCK", 500, ["HIGH"]), type: "JUDGING" },
  contest("CANTINA", null, ["medium"]),
];

function api(over: { watson?: () => Response; resume?: () => Response } = {}) {
  return mockFetch((u) => {
    if (u.pathname.startsWith("/watson/")) return (over.watson ?? (() => json(WATSON)))();
    if (u.pathname.startsWith("/stats/resume/")) return (over.resume ?? (() => json(RESUME)))();
    return json({ error: "not found" }, 404);
  });
}

beforeEach(() => { __resetLimiters(); });

describe("collectAudits", () => {
  it("профіль вказує GitHub людини: зведення резюме за постачальником", async () => {
    const { fetchImpl, calls } = api();
    const ctx = ctxWith(fetchImpl);
    const r = await collectAudits("Test_Auditor", { github: "test-dev", x: "someone_else" }, ctx);
    expect(r).toEqual({ ok: true, facts: {
      earningsUsd: 3500.75, high: 4, contests: 4, verifiedBy: "github",
      providers: {
        SHERLOCK: { earningsUsd: 1000.5, high: 1, medium: 1, contests: 1 },
        CODE4RENA: { earningsUsd: 2500.25, high: 3, medium: 1, contests: 2 },
        CANTINA: { earningsUsd: 0, high: 0, medium: 1, contests: 1 },
      },
    } });
    expect(calls.map((c) => c.url.toString())).toEqual([
      "https://mainnet-contest.sherlock.xyz/watson/test_auditor",
      "https://mainnet-contest.sherlock.xyz/stats/resume/test_auditor",
    ]);
    expect(ctx.sleeps).toEqual([SHERLOCK_PAUSE_MS]);
    expect(SHERLOCK_PAUSE_MS).toBeGreaterThanOrEqual(2_500);
  });

  it("збіг лише за X (посилання в профілі, інший регістр): verifiedBy x", async () => {
    const { fetchImpl } = api();
    const r = await collectAudits("test_auditor", { github: "not-me", x: "@TEST_x" }, ctxWith(fetchImpl));
    expect(r).toMatchObject({ ok: true, facts: { verifiedBy: "x" } });
  });

  it("профіль не вказує ні GitHub, ні X людини: прогалина, резюме не питаємо", async () => {
    const { fetchImpl, calls } = api();
    const r = await collectAudits("test_auditor", { github: "impostor", x: "impostor_x" }, ctxWith(fetchImpl));
    expect(r).toEqual({ ok: false, gap: "audits: Sherlock profile does not link this person's GitHub or X" });
    expect(calls).toHaveLength(1);
  });

  it("немає GitHub і X для перевірки: прогалина без запитів", async () => {
    const { fetchImpl, calls } = api();
    const r = await collectAudits("test_auditor", {}, ctxWith(fetchImpl));
    expect(r).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });

  it("профілю немає (404): прогалина", async () => {
    const { fetchImpl } = api({ watson: () => json({ error: "Watson does not exist" }, 404) });
    expect(await collectAudits("nobody", { github: "test-dev" }, ctxWith(fetchImpl)))
      .toEqual({ ok: false, gap: "audits: no Sherlock profile with this handle" });
  });

  it("перевірений профіль без жодного конкурсу: прогалина, а не нуль", async () => {
    const { fetchImpl } = api({ resume: () => json([]) });
    expect(await collectAudits("test_auditor", { github: "test-dev" }, ctxWith(fetchImpl)))
      .toEqual({ ok: false, gap: "audits: verified Sherlock profile has no contests" });
  });

  it("резюме недоступне: прогалина з кодом", async () => {
    const { fetchImpl } = api({ resume: () => json({ error: "gone" }, 410) });
    expect(await collectAudits("test_auditor", { github: "test-dev" }, ctxWith(fetchImpl)))
      .toEqual({ ok: false, gap: "audits: Sherlock resume unavailable (HTTP 410)" });
  });

  it("нік, що вийшов би за межі шляху, відкидається без запиту", async () => {
    const { fetchImpl, calls } = api();
    expect(await collectAudits("../admin", { github: "test-dev" }, ctxWith(fetchImpl)))
      .toEqual({ ok: false, gap: "audits: invalid Sherlock handle" });
    expect(calls).toHaveLength(0);
  });

  it("нормалізація ніка з профілю", () => {
    expect(normHandle("https://github.com/Test-Dev/")).toBe("test-dev");
    expect(normHandle("@Test_X")).toBe("test_x");
    expect(normHandle(null)).toBe("");
  });

  it("зведення ігнорує не-конкурси і рахує CRITICAL як high", () => {
    expect(summarizeResume([{ type: "JUDGING", provider: "SHERLOCK", payout: 9 }])).toEqual({ earningsUsd: 0, high: 0, contests: 0, providers: {} });
    expect(summarizeResume([{ type: "CONTEST", provider: "X", payout: 0.1, issues: [{ severity: "CRITICAL" }] },
      { type: "CONTEST", provider: "X", payout: 0.2, issues: null }])).toMatchObject({ earningsUsd: 0.3, high: 1, contests: 2 });
  });
});

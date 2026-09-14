// Частину випадків перенесено з NextRole (crypto-jobs-agent, scanner): src/normalize.test.ts.
import { describe, expect, it } from "vitest";
import { dedupeKey, jobId, titleKey } from "./ids.js";
import { officeOnly, prepare, WINDOWS } from "./prepare.js";
import { jobTags } from "./tags.js";
import type { RawJob } from "./types.js";

const NOW = new Date("2026-09-14T04:30:00Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const raw = (o: Partial<RawJob> = {}): RawJob => ({
  url: "https://jobs.example.com/1", company: "Example Labs", title: "Partnerships Manager",
  location: "Remote", remote: true, postedAt: daysAgo(7), source: "ashby:example", crypto: true, ...o,
});

describe("id і ключ змісту", () => {
  it("id з адреси: стабільний, короткий, різний для різних адрес", () => {
    expect(jobId("https://a.example/1")).toBe(jobId(" https://a.example/1 "));
    expect(jobId("https://a.example/1")).toMatch(/^j[0-9a-f]{24}$/);
    expect(jobId("https://a.example/1")).not.toBe(jobId("https://a.example/2"));
  });
  it("геоклони дають один ключ, гендерні позначки не заважають", () => {
    expect(titleKey("Data Analyst (m/f/d)")).toBe(titleKey("Data  Analyst"));
    expect(dedupeKey("Example Inc.", "Backend Engineer")).toBe(dedupeKey("Example", "Backend Engineer (Remote)"));
  });
  it("назва без латиниці не дає порожнього ключа", () => {
    expect(titleKey("Розробник")).toBe("розробник");
    expect(dedupeKey("X", "Розробник")).not.toBe(dedupeKey("X", "Аналітик"));
  });
});

describe("prepare: лише крипто, вікно за родом джерела, дедуп за повнотою", () => {
  it("не крипто за словом джерела не йде в базу", () => {
    const { rows, dropped } = prepare([raw({ crypto: false })], WINDOWS, NOW);
    expect(rows).toHaveLength(0);
    expect(dropped.notCrypto).toBe(1);
  });

  it("компанія зі списку не-крипто відсіюється (той самий список, що в добірці)", () => {
    const { rows, dropped } = prepare([raw({ company: "Crusoe" }), raw({ url: "https://x.example/2", company: "Notion Labs Inc" })], WINDOWS, NOW);
    expect(rows.map((r) => r.company)).toEqual(["Notion Labs Inc"]);
    expect(dropped.company).toBe(1);
  });

  it("дошка: старше за 30 днів відсіюється, без дати лишається", () => {
    const board = { source: "board:web3career" };
    const { rows, dropped } = prepare([raw({ ...board, postedAt: daysAgo(31) }),
      raw({ ...board, url: "https://x.example/2", title: "Other", postedAt: null })], WINDOWS, NOW);
    expect(rows.map((r) => r.title)).toEqual(["Other"]);
    expect(dropped.old).toBe(1);
  });

  it("власний фід роботодавця на ATS: до 90 днів; дошки й агрегатори (і невідомий рід) 30", () => {
    const jobs = [
      raw({ url: "https://x.example/ats60", title: "ATS 60", source: "greenhouse:acme", postedAt: daysAgo(60) }),
      raw({ url: "https://x.example/ats91", title: "ATS 91", source: "lever_eu:acme", postedAt: daysAgo(91) }),
      raw({ url: "https://x.example/w3c40", title: "Board 40", source: "board:web3career", postedAt: daysAgo(40) }),
      raw({ url: "https://x.example/sr40", title: "Speedrun 40", source: "aggregator:speedrun", postedAt: daysAgo(40) }),
      raw({ url: "https://x.example/odd40", title: "Unknown 40", source: "careers:acme", postedAt: daysAgo(40) }),
    ];
    const { rows, dropped } = prepare(jobs, WINDOWS, NOW);
    expect(rows.map((r) => r.title)).toEqual(["ATS 60"]);
    expect(dropped.old).toBe(4);
    expect(WINDOWS).toEqual({ board: 30, ats: 90 });
  });

  it("з двох джерел лишається те, де є зарплата; та сама адреса двічі = один рядок", () => {
    const bare = raw({ url: "https://jobstash.xyz/jobs/1", source: "board:jobstash" });
    const rich = raw({ url: "https://web3.career/x/1", source: "board:web3career", salaryMin: 135_050, salaryMax: 300_000, salaryCurrency: "usd" });
    const same = raw({ title: "Different Title", source: "ashby:example" });
    const { rows, dropped } = prepare([bare, rich, same, same], WINDOWS, NOW);
    expect(rows.map((r) => [r.source, r.salaryMin, r.salaryCurrency])).toEqual([
      ["board:web3career", 135_050, "USD"], ["ashby:example", null, null],
    ]);
    expect(dropped.duplicate).toBe(2);
  });

  it("рядок: id з адреси, ключ компанії добірки, теги з web3 першим, вилка з тексту", () => {
    const { rows } = prepare([raw({ title: "Senior Solidity Engineer", company: "Acme Protocol Inc.",
      description: "Compensation: $120,000 - $150,000 per year plus equity." })], WINDOWS, NOW);
    expect(rows[0]).toMatchObject({
      id: jobId("https://jobs.example.com/1"), companyKey: "acme protocol", dedupeKey: "acme protocol|senior solidity engineer",
      tags: ["web3", "engineering", "remote"], salaryMin: 120_000, salaryMax: 150_000, salaryCurrency: "USD",
      fetchedAt: NOW.toISOString(),
    });
  });

  it("локація, що заперечує «віддалено», перемагає прапорець", () => {
    expect(officeOnly("NYC Office")).toBe(true);
    expect(officeOnly("Remote or In Office")).toBe(false);
    expect(officeOnly("In office not remote")).toBe(true);
    const { rows } = prepare([raw({ location: "Tallinn Office", remote: true })], WINDOWS, NOW);
    expect(rows[0]!.remote).toBe(false);
    expect(rows[0]!.tags).not.toContain("remote");
  });

  it("без адреси, назви чи компанії не рядок", () => {
    const { rows, dropped } = prepare([raw({ url: "mailto:a@b.c" }), raw({ title: " " }), raw({ company: "" })], WINDOWS, NOW);
    expect(rows).toHaveLength(0);
    expect(dropped.broken).toBe(3);
  });

  it("теги сфери", () => {
    expect(jobTags("Head of Business Development", false)).toEqual(["web3", "partnerships"]);
    expect(jobTags("Community Manager", true)).toEqual(["web3", "devrel", "remote"]);
  });
});

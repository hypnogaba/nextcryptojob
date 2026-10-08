import { describe, expect, it } from "vitest";
import { prepare, WINDOWS } from "../prepare.js";
import type { Company, RawJob } from "../types.js";
import { titleFiltered } from "./ats.js";
import { CHAINJOBS_SOURCE, parseChainJobs } from "./chainjobs.js";

const REG: Company[] = [
  { slug: "coinbase", name: "Coinbase", provider: "greenhouse", atsSlug: "coinbase" },
  { slug: "kraken.com", name: "Kraken", provider: "ashby", atsSlug: "kraken.com" },
];
const cj = (o: Record<string, unknown>) => ({
  id: "a1", title: "Protocol Engineer", company: "Tether", apply_url: "https://careers.tether.io/jobs/1",
  location: "Remote", remote: true, date_posted: "2026-10-08", ...o,
});

describe("ChainJobs: лише те, чого прямі джерела не дають", () => {
  it("бере вакансію компанії поза реєстром, з адресою роботодавця як є", () => {
    const [j] = parseChainJobs([cj({})], REG);
    expect(j).toMatchObject({ url: "https://careers.tether.io/jobs/1", company: "Tether", source: CHAINJOBS_SOURCE, remote: true, crypto: true });
    expect(j!.postedAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("відкидає дошку ATS, яку скан читає сам (регістр слага не важить), і компанію з реєстру на її домені", () => {
    const jobs = parseChainJobs([
      cj({ company: "Kraken Digital", apply_url: "https://jobs.ashbyhq.com/Kraken.com/abc" }),
      cj({ company: "Coinbase", apply_url: "https://www.coinbase.com/careers/positions/123" }),
      cj({ company: "Unknown Co", apply_url: "https://job-boards.greenhouse.io/unknownco/jobs/9" }),
    ], REG);
    expect(jobs.map((j) => j.company)).toEqual(["Unknown Co"]);
  });

  it("без адреси, назви чи компанії, або не http(s): геть", () => {
    expect(parseChainJobs([cj({ apply_url: "" }), cj({ title: " " }), cj({ company: null }), cj({ apply_url: "mailto:a@b.c" })], REG)).toEqual([]);
  });

  it("та сама компанія й назва, що в ATS: лишається ATS, навіть коли запис ChainJobs повніший", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const base: RawJob = { url: "https://jobs.ashbyhq.com/tether/1", company: "Tether", title: "Protocol Engineer", location: null,
      remote: true, postedAt: "2026-10-07T00:00:00Z", source: "ashby:tether", crypto: true };
    const chain: RawJob = { ...base, url: "https://careers.tether.io/jobs/1", location: "Remote", salaryMin: 100_000, salaryMax: 150_000, salaryCurrency: "USD", source: CHAINJOBS_SOURCE };
    const { rows, dropped } = prepare([chain, base], WINDOWS, now);
    expect(rows.map((r) => r.source)).toEqual(["ashby:tether"]);
    expect(dropped.duplicate).toBe(1);
  });
});

describe("Block і Robinhood: лише крипто-вакансії за назвою", () => {
  const j = (title: string): RawJob => ({ url: `https://x/${title}`, company: "Robinhood", title, location: null, remote: false, postedAt: null, source: "greenhouse:robinhood", crypto: true });
  it("лишає вакансії з крипто-словом, решту прибирає; інших роботодавців не чіпає", () => {
    const jobs = [j("Crypto Risk Lead"), j("Staff Software Engineer, Web3"), j("Staff iOS Software Engineer, Bitcoin"), j("Senior Accountant"), j("Prototype Designer")];
    expect(titleFiltered("greenhouse:robinhood", jobs).map((x) => x.title)).toEqual(["Crypto Risk Lead", "Staff Software Engineer, Web3", "Staff iOS Software Engineer, Bitcoin"]);
    expect(titleFiltered("greenhouse:coinbase", jobs)).toHaveLength(5);
  });
});

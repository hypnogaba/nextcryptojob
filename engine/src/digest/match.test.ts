import { describe, expect, it } from "vitest";
import {
  type DigestJob, type DigestProfile, formatSalary, isRemoteLocation, keywordHit, meetsFloor, mentionsCity, roleKeywords,
  selectJobs, whyLine,
} from "./match.js";

const NOW = new Date("2026-09-12T10:00:00Z");
const daysAgo = (d: number) => NOW.getTime() - d * 86_400_000;

let seq = 0;
function job(p: Partial<DigestJob> & { title?: string } = {}): DigestJob {
  seq++;
  const id = p.id ?? `j${seq}`;
  const source = p.source ?? "nextrole";
  return {
    ref: p.ref ?? `${source === "company" ? "co" : "nr"}:${id}`, source, id, title: p.title ?? "Senior Solidity Engineer",
    company: p.company ?? `Company ${seq}`, companyKey: p.companyKey ?? `company ${seq}`, url: `https://jobs.example/${id}`,
    location: p.location ?? "Remote", placeText: p.placeText ?? p.location ?? "Remote", remote: p.remote ?? true,
    country: p.country ?? null, salary: p.salary ?? null, postedAt: p.postedAt === undefined ? daysAgo(2) : p.postedAt,
    seenAt: p.seenAt ?? daysAgo(1), dedupeKey: p.dedupeKey ?? null, roles: p.roles ?? ["engineer"],
  };
}

const profile = (p: Partial<DigestProfile> = {}): DigestProfile => ({
  roles: ["engineer"], remoteMode: "remote", city: null, salaryMin: null, salaryCurrency: null, ...p,
});

const pick = (crawl: DigestJob[], prof: DigestProfile, company: DigestJob[] = [], exclude: string[] = []) =>
  selectJobs({ crawl, company }, prof, { now: NOW, exclude: new Set(exclude) });

describe("selectJobs: роль", () => {
  it("лише вакансії з роллю людини, не більше п'яти", () => {
    const pool = [...Array.from({ length: 7 }, () => job()), job({ roles: ["designer"] }), job({ roles: [] })];
    const out = pick(pool, profile());
    expect(out).toHaveLength(5);
    expect(out.every((p) => p.job.roles.includes("engineer"))).toBe(true);
  });

  it("друга роль людини не зникає за першою: набір по колу", () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => job({ roles: ["trader"], postedAt: daysAgo(1 + i * 0.01) })),
      job({ roles: ["product_manager"], postedAt: daysAgo(20) }),
    ];
    const out = pick(pool, profile({ roles: ["trader", "product_manager"] }));
    expect(out.map((p) => p.role)).toContain("product_manager");
  });
});

describe("своя роль словами (users.role_text)", () => {
  it("ділить текст на фрази й відкидає рівень і службові слова", () => {
    expect(roleKeywords("Senior Tokenomics Designer, governance lead / ZK researcher")).toEqual([
      ["tokenomics", "designer"], ["governance"], ["zk", "researcher"],
    ]);
    expect(roleKeywords("tokenomics or incentives design")).toEqual([["tokenomics"], ["incentives", "design"]]);
    expect(roleKeywords("  ")).toEqual([]);
    expect(roleKeywords(null)).toEqual([]);
  });

  it("усі слова фрази мають бути в назві; довге слово збігається з початком, коротке лише цілим", () => {
    const phrases = roleKeywords("tokenomics design, zk");
    expect(keywordHit("Senior Tokenomics Designer (Remote)", phrases)).toBe("tokenomics design");
    expect(keywordHit("Tokenomics Analyst", phrases)).toBeNull();
    expect(keywordHit("ZK Circuit Engineer", phrases)).toBe("zk");
    expect(keywordHit("zkSync Engineer", phrases)).toBeNull();
  });

  it("вакансія не нашої ролі, але зі словами людини в назві, теж іде, з поясненням її словами", () => {
    const own = job({ title: "Tokenomics Designer", roles: ["designer"] });
    const other = job({ title: "Brand Designer", roles: ["designer"] });
    const out = pick([own, other, job()], profile({ roles: ["engineer"], roleText: "Tokenomics designer" }));
    expect(out.map((p) => p.job.id).sort()).toEqual([own.id, out.find((p) => p.job.roles.includes("engineer"))!.job.id].sort());
    const hit = out.find((p) => p.job.id === own.id)!;
    expect(hit).toMatchObject({ role: "designer", keyword: "tokenomics designer" });
    expect(hit.why).toBe('Matches "tokenomics designer" from your own words. Remote.');
  });

  it("без ролей, але зі своєю роллю словами, добірка не порожня; без обох порожня", () => {
    const own = job({ title: "Governance Lead", roles: ["operations_support"] });
    expect(pick([own], profile({ roles: [], roleText: "governance" })).map((p) => p.job.id)).toEqual([own.id]);
    expect(pick([own], profile({ roles: [], roleText: null }))).toEqual([]);
  });
});

describe("selectJobs: місце", () => {
  const paris = job({ location: "Paris, France", remote: false });
  const remote = job({ location: "Anywhere, Anywhere", remote: true });
  const london = job({ location: "London, UK", remote: false });

  it("remote: лише віддалені", () => {
    expect(pick([paris, remote, london], profile({ remoteMode: "remote" })).map((p) => p.job.id)).toEqual([remote.id]);
  });

  it("city: лише ті, де є місто людини, без регістру й діакритики", () => {
    const out = pick([paris, remote, london], profile({ remoteMode: "city", city: "PARÍS" }));
    expect(out.map((p) => p.job.id)).toEqual([paris.id]);
    expect(out[0]!.place).toBe("city");
  });

  it("remote,city: обидва, місто спершу, навіть якщо віддалена свіжіша", () => {
    const freshRemote = job({ location: "Remote", postedAt: daysAgo(0.1) });
    const oldParis = job({ location: "Paris", remote: false, postedAt: daysAgo(25) });
    const out = pick([freshRemote, oldParis], profile({ remoteMode: "remote,city", city: "Paris" }));
    expect(out.map((p) => p.job.id)).toEqual([oldParis.id, freshRemote.id]);
  });

  it("місто не збігається з частиною іншого слова", () => {
    expect(mentionsCity("Parisian Hills, TX", "Paris")).toBe(false);
    expect(mentionsCity("Paris / London / Amsterdam", "paris")).toBe(true);
    expect(mentionsCity("NYC or Remote", "New York")).toBe(true);
    expect(mentionsCity("Kiev, Ukraine", "Kyiv")).toBe(true);
  });

  it("гібрид з прапорцем remote не віддалений; «Anywhere» без прапорця віддалений", () => {
    expect(isRemoteLocation(true, "New York - Hybrid")).toBe(false);
    expect(isRemoteLocation(false, "Anywhere, Anywhere")).toBe(true);
    expect(isRemoteLocation(true, "Remote / Hybrid - London")).toBe(true);
  });

  it("вакансія національної дошки (country) не йде у «віддалено»", () => {
    const dou = job({ location: "Remote", country: "UA" });
    expect(pick([dou], profile())).toEqual([]);
  });
});

describe("selectJobs: зарплата м'яко", () => {
  const withSalary = (usd: number, currency = "USD") => job({ salary: { min: usd, max: usd + 20_000, currency, period: "year" } });

  it("вакансія без зарплати не відкидається і стоїть вище за відому нижчу за мінімум", () => {
    const none = job({ postedAt: daysAgo(10) });
    const low = job({ salary: { min: 40_000, max: 50_000, currency: "USD", period: "year" }, postedAt: daysAgo(1) });
    const out = pick([low, none], profile({ salaryMin: 100_000, salaryCurrency: "USD" }));
    expect(out.map((p) => p.job.id)).toEqual([none.id, low.id]);
    expect(out[0]!.meetsSalary).toBeNull();
    expect(out[1]!.meetsSalary).toBe(false);
  });

  it("та, що дотягує до мінімуму, вище за ту, де зарплати немає", () => {
    const none = job({ postedAt: daysAgo(1) });
    const good = withSalary(120_000);
    good.postedAt = daysAgo(20);
    const out = pick([none, good], profile({ salaryMin: 100_000, salaryCurrency: "USD" }));
    expect(out.map((p) => p.job.id)).toEqual([good.id, none.id]);
  });

  it("мінімум у фунтах порівнюється з доларами грубо за курсом", () => {
    const j = withSalary(118_000); // до 138k $
    expect(meetsFloor(j, 100_000, "GBP")).toBe(true); // 127k $
    expect(meetsFloor(j, 120_000, "GBP")).toBe(false); // 152k $
  });

  it("незнайома валюта і заглушка 1 000 = невідомо, а не «нижче»", () => {
    expect(meetsFloor(withSalary(150_000, "SGD"), 100_000, "USD")).toBeNull();
    expect(meetsFloor(job({ salary: { min: 1_000, max: null, currency: "USD", period: "year" } }), 100_000, "USD")).toBeNull();
    expect(formatSalary({ min: 1_000, max: null, currency: "USD", period: "year" })).toBeNull();
  });

  it("без мінімуму в людини зарплата не впливає на порядок", () => {
    const newer = job({ postedAt: daysAgo(1) });
    const paid = withSalary(200_000);
    paid.postedAt = daysAgo(5);
    expect(pick([paid, newer], profile()).map((p) => p.job.id)).toEqual([newer.id, paid.id]);
  });
});

describe("selectJobs: свіжість, компанії, виключення", () => {
  it("старші за 30 днів відкидаються, новіші спершу; без дати публікації рахується дата, коли бачили", () => {
    const old = job({ postedAt: daysAgo(31) });
    const mid = job({ postedAt: daysAgo(10) });
    const fresh = job({ postedAt: daysAgo(1) });
    const undated = job({ postedAt: null, seenAt: daysAgo(0.5) });
    expect(pick([old, mid, fresh, undated], profile()).map((p) => p.job.id)).toEqual([undated.id, fresh.id, mid.id]);
  });

  it("одна вакансія на компанію", () => {
    const a = job({ companyKey: "okx" });
    const b = job({ companyKey: "okx" });
    const c = job({ companyKey: "kraken" });
    const out = pick([a, b, c], profile());
    expect(out.map((p) => p.job.companyKey).sort()).toEqual(["kraken", "okx"]);
  });

  it("надіслане раніше не повторюється, і та сама вакансія під новою адресою теж", () => {
    const sentBefore = job({ dedupeKey: "acme|solidity engineer" });
    const repost = job({ dedupeKey: "acme|solidity engineer" });
    const other = job();
    const out = pick([sentBefore, repost, other], profile(), [], [sentBefore.ref]);
    expect(out.map((p) => p.job.id)).toEqual([other.id]);
  });

  it("не більше однієї вакансії компанії, і лише з роллю людини; вона перша", () => {
    const co1 = job({ source: "company", roles: ["engineer"], postedAt: daysAgo(40) });
    const co2 = job({ source: "company", roles: ["engineer"] });
    const coWrongRole = job({ source: "company", roles: ["designer"] });
    const nr = Array.from({ length: 6 }, () => job());
    const out = pick(nr, profile(), [coWrongRole, co1, co2]);
    expect(out).toHaveLength(5);
    expect(out.filter((p) => p.job.source === "company")).toHaveLength(1);
    expect(out[0]!.job.source).toBe("company");
    // 30 днів не стосуються вакансій компаній: вони живуть, поки оплачені й відкриті.
    expect([co1.id, co2.id]).toContain(out[0]!.job.id);
  });

  it("вакансію компанії, яку людина вже отримала, вдруге не шлемо", () => {
    const co = job({ source: "company" });
    expect(pick([], profile(), [co], [co.ref])).toEqual([]);
  });

  it("вакансія компанії не в тому місці не йде", () => {
    const co = job({ source: "company", remote: false, location: "Berlin", placeText: "Berlin" });
    expect(pick([], profile({ remoteMode: "city", city: "Paris" }), [co])).toEqual([]);
  });
});

describe("whyLine", () => {
  it("детермінований рядок англійською без довгого тире", () => {
    const j = job({ salary: { min: 120_000, max: 150_000, currency: "USD", period: "year" } });
    const line = whyLine({ job: j, role: "security_auditor", place: "remote", meetsSalary: null }, profile());
    expect(line).toBe("Matches your Security auditor role. Remote. Salary listed: $120k to $150k.");
    expect(line).not.toMatch(/—/);
  });

  it("місто людини без країни, позначка про мінімум, місячна зарплата", () => {
    const j = job({ salary: { min: 8_000, max: 10_000, currency: "EUR", period: "month" } });
    const line = whyLine({ job: j, role: "engineer", place: "city", meetsSalary: true }, profile({ city: "Paris, France" }));
    expect(line).toBe("Matches your Engineer role. In Paris. Salary listed: €8k to €10k a month, meets your minimum.");
  });
});

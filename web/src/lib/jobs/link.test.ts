import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { safeUrl } from "@/lib/digest/format";
import { applyLink, EXTERNAL_JOB_REL, externalJobLink, externalRel, isWeb3CareerUrl, jobVia, WEB3CAREER_REL } from "./link";
import { crawlJob } from "./pool";

/**
 * Умови Web3 Jobs API: посилання на apply_url web3.career follow (без nofollow), адреса без жодної
 * правки, web3.career названо джерелом. Тут поведінка помічника й сторож: код, що показує вакансії,
 * не ставить rel сам і не дописує параметрів.
 */

const APPLY = [
  "https://web3.career/r/wczNxUTM__U4HFyv",
  "https://web3.career/r/=cTMxEDN__U4HFyv",
  "https://web3.career/r/x__U4HFyv?utm_source=w3c&utm_medium=api&ref=U4HFyv&b=2&a=1",
  // new URL().toString() переписав би кожну з цих: регістр хоста, порт 443, «./», порожній запит, «#».
  "https://Web3.Career/r/x__U4HFyv",
  "https://web3.career:443/r/./x__U4HFyv?",
  "https://www.web3.career/r/x__U4HFyv#apply",
];

describe("externalJobLink", () => {
  it("web3.career: the href is the address byte for byte, rel is only noopener, web3.career is named", () => {
    for (const url of APPLY) {
      expect(externalJobLink(url)).toEqual({ href: url, rel: WEB3CAREER_REL, via: "web3.career" });
      expect(safeUrl(url)).toBe(url);
    }
    expect(WEB3CAREER_REL).toBe("noopener");
    expect(externalJobLink(`  ${APPLY[0]}\n`)!.href).toBe(APPLY[0]);
  });

  it("other boards keep noopener noreferrer nofollow and name nobody", () => {
    expect(externalJobLink("https://jobs.lever.co/acme/1?lever-source=x")).toEqual({
      href: "https://jobs.lever.co/acme/1?lever-source=x", rel: EXTERNAL_JOB_REL, via: null });
    expect(EXTERNAL_JOB_REL).toBe("noopener noreferrer nofollow");
    // Схожий, але чужий хост не web3.career.
    for (const url of ["https://web3.career.evil.example/r/x", "https://notweb3.career/r/x", "https://example.com/?u=https://web3.career/"]) {
      expect(isWeb3CareerUrl(url)).toBe(false);
      expect(externalRel(url)).toBe(EXTERNAL_JOB_REL);
      expect(jobVia(url)).toBeNull();
    }
  });

  it("nothing but http(s) or mailto becomes a link, and an address that would need rewriting is not linked", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a url", "", null, undefined, "https://web3.career/r/a b", "https://web3.career/r/a\tb"]) {
      expect(externalJobLink(bad)).toBeNull();
    }
    expect(externalJobLink("mailto:jobs@example.com")!.href).toBe("mailto:jobs@example.com");
  });

  it("the search pool keeps the stored address unchanged", () => {
    for (const url of APPLY) {
      const job = crawlJob({
        id: "j1", url, company: "Koinly", company_key: "koinly", title: "Community Manager", location: "Remote", remote: 1,
        salary_min: null, salary_max: null, salary_currency: null, tags: '["web3"]', posted_at: null,
        fetched_at: "2026-09-14T04:30:00.000Z", country: null, dedupe_key: "koinly|community manager", source: "board:web3career",
      });
      expect(job!.url).toBe(url);
    }
  });
});

describe("applyLink (the Apply button on /jobs)", () => {
  it("web3.career: the apply_url byte for byte, followed (noopener only), in a new tab, web3.career named", () => {
    for (const url of APPLY) {
      expect(applyLink(url)).toEqual({ href: url, newTab: true, rel: WEB3CAREER_REL, label: "Apply", via: "web3.career" });
    }
  });

  it("other boards: the address as is with noopener noreferrer nofollow", () => {
    expect(applyLink("https://jobs.lever.co/acme/1?lever-source=x")).toEqual({
      href: "https://jobs.lever.co/acme/1?lever-source=x", newTab: true, rel: EXTERNAL_JOB_REL, label: "Apply", via: null });
  });

  it("a company job goes through our counted apply route; email applies open the mail app", () => {
    expect(applyLink("/jobs/job_abc")).toEqual({ href: "/jobs/job_abc/apply", newTab: true, rel: "noopener", label: "Apply", via: null });
    expect(applyLink("mailto:jobs@example.com")).toEqual({ href: "mailto:jobs@example.com", newTab: false, rel: null, label: "Apply by email", via: null });
  });

  it("no button for a broken address", () => {
    for (const bad of [null, undefined, "", "javascript:alert(1)", "/jobs/../admin", "https://web3.career/r/a b"]) expect(applyLink(bad)).toBeNull();
  });
});

/** Файли, що показують вакансії зі сканування: сайт, лист, Telegram-бот, search_jobs, адмінка. */
const JOB_LINK_FILES = [
  "app/jobs/page.tsx",
  "components/jobs/job-card.tsx",
  "lib/telegram/bot.ts",
  "app/admin/sources/page.tsx",
  "components/landing/job-ticker.tsx",
  "lib/jobs/home-board.ts",
  "lib/jobs/instant.ts",
  "lib/jobs/pool.ts",
  "lib/digest/history.ts",
  "lib/digest/format.ts",
  "lib/mail/digest.ts",
  "lib/crm/public-jobs.ts",
];

const SRC = join(__dirname, "..", "..");

/** Код без коментарів: пояснення в коментарях можуть називати заборонене. «https://» не коментар. */
const code = (path: string): string =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("no job link bypasses the helper", () => {
  it("files that show crawl jobs never write rel or nofollow themselves and never rebuild the address", () => {
    for (const file of JOB_LINK_FILES) {
      const text = code(join(SRC, file));
      expect(text, file).not.toMatch(/rel="[^"]*"/);
      expect(text, file).not.toMatch(/nofollow/);
      // Адресу вакансії не збирають наново (new URL(job.url).toString() нормалізує її); адреси нашого сайту можна.
      expect(text, file).not.toMatch(/searchParams\.(set|append)|new URL\((?:\w+\.)?(?:url|href|raw)\b[^)]*\)\.(toString|href)\b|\.href\s*=/);
    }
  });

  it("no code in the site appends tracking parameters to any link", () => {
    const offenders = sources(SRC)
      .filter((path) => /utm_(source|medium|campaign)|[?&]ref=/.test(code(path)))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});

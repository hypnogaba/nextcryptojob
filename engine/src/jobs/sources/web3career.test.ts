// web3.career через офіційний API проти СПРАВЖНЬОЇ відповіді (fixtures/web3career-api.json: відповідь
// 14.09.2026, дев'ять вакансій, описи обрізано, токена в знімку немає).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters, __setLimiter } from "../../limits.js";
import { jobId } from "../ids.js";
import { prepare, WINDOWS } from "../prepare.js";
import {
  extractJobs, fetchWeb3Career, hideToken, parseWeb3Career, WEB3CAREER_QUERIES, WEB3CAREER_SOURCE, WEB3CAREER_TAGS,
  web3CareerEstimate, web3CareerPay, web3CareerUrl, type Web3CareerJob, type Web3CareerUsage,
} from "./web3career.js";

const BODY = readFileSync(new URL("./fixtures/web3career-api.json", import.meta.url), "utf8");
const JOBS = (JSON.parse(BODY) as unknown[])[2] as Web3CareerJob[];
const BOARD = { name: WEB3CAREER_SOURCE, cryptoOnly: true };
const TOKEN = "tok_SECRET-123/+=";
const NOW = new Date("2026-09-14T04:30:00Z");

beforeEach(() => {
  __resetLimiters();
  // Справжня пауза бюджету web3career 1,5 с (limits.ts); у тестах без неї.
  __setLimiter("web3.career", { concurrency: 1, minIntervalMs: 0 });
});
afterEach(() => __resetLimiters());

/** Помилка, якою впав проміс (тест падає, якщо проміс не впав). */
async function failure(p: Promise<unknown>): Promise<Error & { status?: number }> {
  try { await p; } catch (e) { return e as Error & { status?: number }; }
  throw new Error("expected a failure");
}

/** Підставний API: запам'ятовує адреси, відповідає знімком або статусом. */
function api(answer: (url: URL, i: number) => Response = () => new Response(BODY, { status: 200 })) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string) => {
    const u = new URL(String(input));
    urls.push(u);
    return answer(u, urls.length - 1);
  }) as unknown as typeof fetch;
  return { urls, o: { fetchImpl, retries: 0, retryDelayMs: 0 } };
}

describe("відповідь API", () => {
  it("вакансії з вкладеного масиву; корінь з вакансій теж; самі рядки = нуль; інше = збій", () => {
    expect(extractJobs(JSON.parse(BODY))).toHaveLength(9);
    expect(extractJobs([{ id: 1 }, { id: 2 }])).toHaveLength(2);
    expect(extractJobs(["Web3 Jobs API", "params"])).toEqual([]);
    expect(() => extractJobs({ error: "x" })).toThrow(/не масив/);
    expect(() => extractJobs([1, 2])).toThrow(/немає масиву/);
  });

  it("apply_url іде в url рядком, як дав API; id з номера вакансії; назва без сутностей", () => {
    const jobs = parseWeb3Career(JOBS, BOARD);
    expect(jobs.map((j) => j.url)).toEqual(JOBS.map((j) => j.apply_url));
    expect(jobs[0]).toMatchObject({
      url: "https://web3.career/r/wczNxUTM__U4HFyv", idKey: "web3career:151770", title: "Social Media and Community Manager",
      company: "Koinly", location: "Remote", remote: true, postedAt: "2026-09-13T00:00:52.000Z", source: WEB3CAREER_SOURCE, crypto: true,
    });
    expect(jobs[0]!.boardTags).toContain("community-manager");
    expect(jobs.find((j) => j.idKey === "web3career:153514")!.title).toBe("Community & Events Manager (Turkey)");
    expect(jobs.find((j) => j.idKey === "web3career:154039")).toMatchObject({ location: "NY New York US", remote: false });
    expect(jobs.every((j) => !/<[a-z]/i.test(j.description ?? ""))).toBe(true);
  });

  it("вилка: рік як є, година й місяць у рік, без валюти USD, оцінка дошки не вилка", () => {
    const by = (id: number) => web3CareerPay(JOBS.find((j) => j.id === id)!);
    expect(by(151770)).toEqual({ salaryMin: 54_000, salaryMax: 66_000, salaryCurrency: "USD" }); // без одиниці й валюти
    expect(by(154034)).toEqual({ salaryMin: 99_815, salaryMax: 148_400, salaryCurrency: "USD" }); // YEAR USD
    expect(by(41117)).toEqual({ salaryMin: 52_000, salaryMax: 104_000, salaryCurrency: "USD" }); // 25 до 50 на годину
    expect(by(106577)).toEqual({ salaryMin: 36_000, salaryMax: 72_000, salaryCurrency: "USD" }); // 3 000 до 6 000 на місяць
    expect(by(154039)).toEqual({ salaryMin: null, salaryMax: null, salaryCurrency: null }); // лише estimated_*
    // Без одиниці сума береться річною лише правдоподібна: «4 500» це місяць, а не річна зарплата.
    expect(web3CareerPay({ salary_min_value: "4500.0", salary_max_value: null })).toEqual({ salaryMin: null, salaryMax: null, salaryCurrency: null });
  });

  it("оцінка web3.career окремо від вилки: лише без вилки роботодавця, лише правдоподібна", () => {
    const by = (id: number) => JOBS.find((j) => j.id === id)!;
    expect(web3CareerEstimate(by(154039))).toEqual({ min: 180_000, max: 225_000, currency: "USD" });
    expect(web3CareerEstimate(by(151770))).toBeNull(); // є вилка роботодавця
    expect(web3CareerEstimate({ estimated_min_salary: 900, estimated_max_salary: 1200 })).toBeNull();
    const [raw] = parseWeb3Career([by(154039)], BOARD);
    const { rows } = prepare([raw!], WINDOWS, NOW);
    expect(rows[0]).toMatchObject({ salaryMin: null, salaryMax: null, salaryCurrency: null,
      salaryEstMin: 180_000, salaryEstMax: 225_000, salaryEstCurrency: "USD" });
    const paid = prepare(parseWeb3Career([by(154034)], BOARD), WINDOWS, NOW).rows[0]!;
    expect(paid).toMatchObject({ salaryMin: 99_815, salaryEstMin: null, salaryEstMax: null });
  });

  it("prepare: адреса web3.career з мітками лишається байт у байт, id з номера", () => {
    const apply = "https://web3.career/r/=cTMxEDN__U4HFyv?utm_source=partner&utm_medium=api&ref=U4HFyv&b=2&a=1";
    const [raw] = parseWeb3Career([{ ...JOBS[0]!, id: 777, apply_url: apply }], BOARD);
    const { rows } = prepare([raw!], WINDOWS, NOW);
    expect(rows[0]!.url).toBe(apply);
    expect(rows[0]!.id).toBe(jobId("web3career:777"));
    expect(rows[0]!.tags).toEqual(expect.arrayContaining(["web3", "community", "marketing", "remote"]));
  });
});

describe("запити скану", () => {
  it("кожен тег запиту відомий API; ролі, яких бракує, запитуються окремо", () => {
    const tags = WEB3CAREER_QUERIES.map((q) => q.tag).filter((t): t is string => Boolean(t));
    expect(tags.filter((t) => !WEB3CAREER_TAGS.has(t))).toEqual([]);
    for (const t of ["developer-relations", "community-manager", "moderator", "ambassador", "kol", "social-media", "trader", "security"]) {
      expect(tags).toContain(t);
    }
    expect(WEB3CAREER_QUERIES.length).toBeLessThanOrEqual(60);
    expect(new Set(WEB3CAREER_QUERIES.map((q) => JSON.stringify(q))).size).toBe(WEB3CAREER_QUERIES.length);
  });

  it("адреса: токен, limit=100 і фільтри; більше нічого", () => {
    const u = new URL(web3CareerUrl(TOKEN, { country: "united-states", tag: "crypto" }));
    expect(`${u.origin}${u.pathname}`).toBe("https://web3.career/api/v1");
    expect(Object.fromEntries(u.searchParams)).toEqual({ token: TOKEN, limit: "100", tag: "crypto", country: "united-states" });
  });

  it("усі зрізи по черзі, та сама вакансія з кількох зрізів одна", async () => {
    const { urls, o } = api();
    const usage: Web3CareerUsage = { requests: 0, empty: 0, failed: 0, jobs: 0 };
    const jobs = await fetchWeb3Career(TOKEN, BOARD, o, WEB3CAREER_QUERIES, usage);
    expect(urls).toHaveLength(WEB3CAREER_QUERIES.length);
    expect(urls.every((u) => u.searchParams.get("token") === TOKEN && u.searchParams.get("limit") === "100")).toBe(true);
    expect(urls.some((u) => u.searchParams.get("show_description") === "false")).toBe(false);
    expect(jobs).toHaveLength(9);
    expect(usage).toEqual({ requests: WEB3CAREER_QUERIES.length, empty: 0, failed: 0, jobs: 9 });
  });

  it("без токена ясна помилка до будь-якого запиту", async () => {
    const { urls, o } = api();
    await expect(fetchWeb3Career(undefined, BOARD, o)).rejects.toThrow(/WEB3CAREER_TOKEN/);
    await expect(fetchWeb3Career("  ", BOARD, o)).rejects.toThrow(/WEB3CAREER_TOKEN/);
    expect(urls).toHaveLength(0);
  });

  it("401: одразу стоп, у помилці немає токена", async () => {
    const { urls, o } = api(() => new Response("bad token", { status: 401 }));
    const err = await failure(fetchWeb3Career(TOKEN, BOARD, o));
    expect(urls).toHaveLength(1);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(encodeURIComponent(TOKEN));
    expect(err.message).toContain("token=***");
  });

  it("429 після повторів: зібране лишається, решта зрізів не питається; нічого не зібрано = 429 джерела", async () => {
    const half = api((_u, i) => (i < 3 ? new Response(BODY, { status: 200 }) : new Response("slow down", { status: 429 })));
    expect(await fetchWeb3Career(TOKEN, BOARD, { ...half.o, maxBackoffMs: 0 })).toHaveLength(9);
    expect(half.urls).toHaveLength(4);
    const none = api(() => new Response("slow down", { status: 429 }));
    const err = await failure(fetchWeb3Career(TOKEN, BOARD, { ...none.o, maxBackoffMs: 0 }));
    expect(err.status).toBe(429);
    expect(err.message).not.toContain(TOKEN);
  });

  it("збій окремого зрізу пропускається; упали всі = збій джерела", async () => {
    const one = api((_u, i) => (i === 1 ? new Response("oops", { status: 500 }) : new Response(BODY, { status: 200 })));
    expect(await fetchWeb3Career(TOKEN, BOARD, one.o)).toHaveLength(9);
    const all = api(() => new Response("oops", { status: 500 }));
    await expect(fetchWeb3Career(TOKEN, BOARD, all.o, WEB3CAREER_QUERIES.slice(0, 3))).rejects.toThrow(/500/);
  });

  it("hideToken ховає і сирий, і закодований токен", () => {
    expect(hideToken(`x ${TOKEN} y ${encodeURIComponent(TOKEN)}`, TOKEN)).toBe("x *** y ***");
  });
});

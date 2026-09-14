import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { __resetLimiters } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { DIGEST_MIGRATIONS, SqliteD1 } from "../testing/sqlite-d1.js";
import { readOnlyJobsDb } from "./jobs-db.js";
import { INTERRUPTED, isDueHour, localClock, runDigestDue, type DigestDeps } from "./schedule.js";

describe("час людини", () => {
  it("година й дата в її поясі", () => {
    expect(localClock(new Date("2026-09-12T01:35:00Z"), "Asia/Kolkata")).toMatchObject({ hour: 7, date: "2026-09-12", tzValid: true });
    // Лос-Анджелес ще вчора.
    expect(localClock(new Date("2026-09-12T05:05:00Z"), "America/Los_Angeles")).toMatchObject({ hour: 22, date: "2026-09-11" });
  });

  it("порожній або невідомий пояс = UTC, і про це видно", () => {
    expect(localClock(new Date("2026-09-12T05:05:00Z"), null)).toMatchObject({ hour: 5, tz: "UTC", tzValid: true });
    expect(localClock(new Date("2026-09-12T05:05:00Z"), "Mars/Olympus")).toMatchObject({ hour: 5, tz: "UTC", tzValid: false });
  });

  it("весняний перевід: 02:00 у Парижі не настає, добірка на 02 іде о 03", () => {
    // 29.03.2026: 01:59 CET → 03:00 CEST.
    const before = localClock(new Date("2026-03-29T00:05:00Z"), "Europe/Paris");
    const after = localClock(new Date("2026-03-29T01:05:00Z"), "Europe/Paris");
    expect([before.hour, after.hour]).toEqual([1, 3]);
    expect(isDueHour(before.hour, 2)).toBe(false);
    expect(isDueHour(after.hour, 2)).toBe(true);
  });

  it("осінній перевід: 02:00 буває двічі, дата та сама (другий раз зупинить UNIQUE)", () => {
    const first = localClock(new Date("2026-10-25T00:05:00Z"), "Europe/Paris");
    const second = localClock(new Date("2026-10-25T01:05:00Z"), "Europe/Paris");
    expect(first).toMatchObject({ hour: 2, date: "2026-10-25" });
    expect(second).toMatchObject({ hour: 2, date: "2026-10-25" });
  });

  it("пора: своя година або наступна, не через північ", () => {
    expect(isDueHour(7, 7)).toBe(true);
    expect(isDueHour(8, 7)).toBe(true);
    expect(isDueHour(9, 7)).toBe(false);
    expect(isDueHour(6, 7)).toBe(false);
    expect(isDueHour(0, 23)).toBe(false);
    expect(isDueHour(5, 99)).toBe(false);
  });
});

// ---------------- прогін з базою ----------------

const NOW = new Date("2026-09-12T05:05:00Z"); // Київ 08:05, Нью-Йорк 01:05
let db: SqliteD1;
let jobs: FakeJobsDb;
let tgCalls: string[];
let emailCalls: string[];
let log: string[];

const okFetch = (async (url: string, init: RequestInit) => {
  if (url.includes("api.telegram.org")) {
    tgCalls.push(String(init.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  emailCalls.push(String(init.body));
  return new Response(null, { status: 202 });
}) as unknown as typeof fetch;

const ENV = { TELEGRAM_BOT_TOKEN: "t", SITE_URL: "https://nextcryptojob.xyz", INTERNAL_API_SECRET: "s" };

function deps(over: Partial<DigestDeps> = {}, now: Date = NOW): DigestDeps {
  let n = 0;
  return {
    db, jobs: readOnlyJobsDb(jobs), env: ENV, now: () => now, log: (l) => log.push(l), fetchImpl: okFetch,
    sleep: async () => undefined, newId: () => `dg_${now.getTime()}_${++n}`, ...over,
  };
}

function addUser(id: string, o: { tz?: string; hour?: number; roles?: string[]; channel?: string; email?: string | null;
  telegram?: string | null; scored?: boolean; remoteMode?: string; city?: string } = {}): void {
  db.exec(
    `INSERT INTO users (id, email, telegram_id, channel, roles, remote_mode, city, digest_hour, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, o.email === undefined ? `${id}@example.com` : o.email, o.telegram === undefined ? `tg-${id}` : o.telegram,
    o.channel ?? "telegram", JSON.stringify(o.roles ?? ["engineer"]), o.remoteMode ?? "remote", o.city ?? null,
    o.hour ?? 8, o.tz ?? "Europe/Kyiv");
  if (o.scored !== false) {
    db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'engineer', 50, 50, 100, '{}', 'v5')", id);
  }
}

function addJobs(n: number, prefix = "j"): void {
  for (let i = 0; i < n; i++) jobs.add({ id: `${prefix}${i}`, title: "Senior Solidity Engineer", company: `Co ${prefix}${i}` });
}

function addCompanyJob(id = "job_1", roles = ["engineer"]): void {
  db.exec("INSERT OR IGNORE INTO companies (id, name, terms_version, terms_accepted_at) VALUES ('co_1', 'Paying Labs', 'v1', datetime('now'))");
  db.exec("INSERT OR IGNORE INTO subscriptions (id, company_id, provider, status, current_period_end) VALUES ('sub_1', 'co_1', 'manual', 'active', datetime('now', '+30 days'))");
  db.exec(`INSERT INTO company_jobs (id, company_id, status, title, roles, remote_mode, apply_url, created_via, published_at, expires_at)
           VALUES (?, 'co_1', 'open', 'Protocol Engineer', ?, 'remote', 'https://paying.example/apply', 'web', datetime('now', '-1 day'), datetime('now', '+59 days'))`,
  id, JSON.stringify(roles));
}

type SentRow = { user_id: string; job_ref: string; source: string; position: number; status: string; channel: string; why: string; digest_id: string };
const sent = () => db.all<SentRow>("SELECT * FROM sent ORDER BY user_id, position");
const runs = () => db.all<{ user_id: string; local_date: string; status: string; jobs: number; error: string | null }>(
  "SELECT user_id, local_date, status, jobs, error FROM digest_runs ORDER BY user_id, local_date");

beforeEach(() => {
  __resetLimiters();
  db = new SqliteD1(DIGEST_MIGRATIONS);
  jobs = new FakeJobsDb(NOW);
  tgCalls = []; emailCalls = []; log = [];
});
afterEach(() => { db.close(); jobs.close(); });

describe("runDigestDue", () => {
  it("кому пора: роль, бал, година; одна добірка з п'яти вакансій, sent і digest_runs записані", async () => {
    addUser("due-user");
    addUser("ny-user", { tz: "America/New_York" }); // 01:05, не пора
    addUser("no-score", { scored: false });
    addUser("no-roles", { roles: [] });
    addJobs(7);
    const s = await runDigestDue(deps());
    expect(s).toMatchObject({ eligible: 2, due: 1, sent: 1, failed: 0 });
    expect(tgCalls).toHaveLength(1);
    expect(runs()).toEqual([{ user_id: "due-user", local_date: "2026-09-12", status: "sent", jobs: 5, error: null }]);
    const rows = sent();
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.every((r) => r.status === "sent" && r.channel === "telegram" && r.source === "nextrole" && r.job_ref.startsWith("nr:"))).toBe(true);
    expect(rows[0]!.why).toBe("Matches your Engineer role. Remote.");
  });

  it("ідемпотентно на дату людини: той самий і наступний запуск того дня нічого не шлють", async () => {
    addUser("u1");
    addJobs(7);
    await runDigestDue(deps());
    const again = await runDigestDue(deps());
    const nextHour = await runDigestDue(deps({}, new Date(NOW.getTime() + 3_600_000)));
    expect(again).toMatchObject({ due: 1, already: 1, sent: 0 });
    expect(nextHour).toMatchObject({ due: 1, already: 1, sent: 0 });
    expect(tgCalls).toHaveLength(1);
    expect(runs()).toHaveLength(1);
  });

  it("наступного дня: нова добірка без уже надісланого", async () => {
    addUser("u1");
    addJobs(8);
    await runDigestDue(deps());
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const s = await runDigestDue(deps({}, tomorrow));
    expect(s.sent).toBe(1);
    const byDigest = new Map<string, string[]>();
    for (const r of sent()) byDigest.set(r.digest_id, [...(byDigest.get(r.digest_id) ?? []), r.job_ref]);
    const [first, second] = [...byDigest.values()];
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(3); // лишилось лише 3 ненадіслані
    expect(first!.some((r) => second!.includes(r))).toBe(false);
  });

  it("гонка: друга копія прогону встигла першою → UNIQUE, нічого не шлемо", async () => {
    addUser("u1");
    addJobs(5);
    db.beforeStatement = (sql) => {
      if (sql.startsWith("SELECT job_ref FROM sent")) {
        db.beforeStatement = null;
        db.exec("INSERT INTO digest_runs (id, user_id, local_date, status, jobs) VALUES ('dg_other', 'u1', '2026-09-12', 'pending', 5)");
      }
    };
    const s = await runDigestDue(deps());
    expect(s).toMatchObject({ already: 1, sent: 0 });
    expect(tgCalls).toHaveLength(0);
    expect(sent()).toHaveLength(0);
  });

  it("пауза (/stop у боті, users.digest_paused = 1): людина з робочим каналом нічого не отримує; /start знімає", async () => {
    // Робочий канал: Telegram прив'язаний, токен бота є, пошта теж є.
    addUser("paused", { channel: "telegram", telegram: "777", email: "p@example.com" });
    addJobs(5);
    db.exec("UPDATE users SET digest_paused = 1 WHERE id = 'paused'");
    const s = await runDigestDue(deps());
    expect(s).toMatchObject({ eligible: 0, due: 0, sent: 0 });
    expect(runs()).toHaveLength(0);
    expect(sent()).toHaveLength(0);
    expect(tgCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(0);
    expect(jobs.seen).toHaveLength(0); // навіть пул не читали

    db.exec("UPDATE users SET digest_paused = 0 WHERE id = 'paused'");
    expect((await runDigestDue(deps())).sent).toBe(1);
    expect(tgCalls).toHaveLength(1);
  });

  it("база без 0011: пауза не діє, добірка йде, у журналі видно чому", async () => {
    db.close();
    db = new SqliteD1(DIGEST_MIGRATIONS.filter((m) => m !== "0011_user_settings.sql"));
    addUser("u1");
    addJobs(5);
    expect((await runDigestDue(deps())).sent).toBe(1);
    expect(log.join("\n")).toMatch(/digest_paused missing/);
  });

  it("демо-кандидат (users.is_demo = 1, 0020) добірки не отримує ніколи, навіть з робочим каналом і без паузи", async () => {
    db.close();
    db = new SqliteD1([...DIGEST_MIGRATIONS, "0020_owner_tools.sql"]);
    addUser("real");
    addUser("demo", { channel: "telegram", telegram: "888", email: "d@example.com" });
    db.exec("UPDATE users SET is_demo = 1 WHERE id = 'demo'");
    addJobs(5);
    const s = await runDigestDue(deps());
    expect(s).toMatchObject({ eligible: 1, sent: 1 });
    expect(runs().map((r) => r.user_id)).toEqual(["real"]);
  });

  it("база без 0020: колонки is_demo ще немає, добірка йде як раніше", async () => {
    addUser("u1");
    addJobs(5);
    expect((await runDigestDue(deps())).sent).toBe(1);
  });

  it("вакансія компанії: не більше однієї, перша, job_ref co:, лічильник digest_shown", async () => {
    addUser("u1");
    addJobs(6);
    addCompanyJob("job_1");
    addCompanyJob("job_2");
    await runDigestDue(deps());
    const rows = sent();
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.source === "company")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "company", position: 1 });
    expect(rows[0]!.job_ref).toMatch(/^co:job_[12]$/);
    const shown = db.all<{ id: string; digest_shown: number }>("SELECT id, digest_shown FROM company_jobs ORDER BY id");
    expect(shown.reduce((a, r) => a + r.digest_shown, 0)).toBe(1);
    const text = JSON.parse(tgCalls[0]!).text as string;
    expect(text).toContain("Posted by Paying Labs on NextCryptoJob");
    // Посилання веде на сторінку вакансії на сайті (там "Apply" рахує перехід), не прямо на apply_url.
    expect(text).toContain(`href="https://nextcryptojob.xyz/jobs/${rows[0]!.job_ref.slice(3)}"`);
    expect(text).not.toContain("paying.example/apply");
  });

  it("ts листа ставиться під час відправки, а не на початку прогону", async () => {
    addUser("u1", { channel: "email", telegram: null });
    addJobs(5);
    // Перший виклик годинника = початок прогону; далі минуло 10 хвилин (паузи Telegram у інших людей).
    const later = new Date(NOW.getTime() + 10 * 60_000);
    let calls = 0;
    const s = await runDigestDue(deps({ now: () => (calls++ === 0 ? NOW : later) }));
    expect(s.sent).toBe(1);
    expect(JSON.parse(emailCalls[0]!).ts).toBe(later.getTime() / 1000);
  });

  it("вакансія компанії без ролі людини не йде", async () => {
    addUser("u1");
    addJobs(2);
    addCompanyJob("job_1", ["designer"]);
    await runDigestDue(deps());
    expect(sent().every((r) => r.source === "nextrole")).toBe(true);
  });

  it("Telegram без токена: людину пропускаємо, у базі нічого, пул не читаємо", async () => {
    addUser("u1");
    addJobs(5);
    const s = await runDigestDue(deps({ env: { SITE_URL: ENV.SITE_URL, INTERNAL_API_SECRET: "s" } }));
    expect(s).toMatchObject({ due: 1, skipped: 1, sent: 0 });
    expect(runs()).toHaveLength(0);
    expect(jobs.seen.filter((q) => q.includes("jobs_cache"))).toHaveLength(0);
    expect(log.join("\n")).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it("пошта не налаштована: failed «email not configured» і в digest_runs, і в sent", async () => {
    addUser("u1", { channel: "email", telegram: null });
    addJobs(5);
    const s = await runDigestDue(deps({ env: {} }));
    expect(s.failed).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", error: "email not configured" });
    expect(sent().every((r) => r.status === "failed" && r.channel === "email")).toBe(true);
  });

  it("бот заблокований: лист замість Telegram, примітка в digest_runs", async () => {
    addUser("u1");
    addJobs(5);
    const blocked = (async (url: string, init: RequestInit) => {
      if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 });
      emailCalls.push(String(init.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const s = await runDigestDue(deps({ fetchImpl: blocked }));
    expect(s.sent).toBe(1);
    expect(emailCalls).toHaveLength(1);
    expect(runs()[0]!.error).toMatch(/blocked.*sent by email instead/);
    expect(sent().every((r) => r.status === "sent" && r.channel === "email")).toBe(true);
  });

  it("нічого не підійшло: digest_runs 'empty', наступна година не шукає вдруге", async () => {
    addUser("u1", { roles: ["trader"] });
    addJobs(3);
    const s = await runDigestDue(deps());
    expect(s.empty).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "empty", jobs: 0 });
    const next = await runDigestDue(deps({}, new Date(NOW.getTime() + 3_600_000)));
    expect(next.already).toBe(1);
  });

  it("нікому не пора: база вакансій не читається зовсім", async () => {
    addUser("u1", { hour: 20 });
    addJobs(3);
    const s = await runDigestDue(deps());
    expect(s.due).toBe(0);
    expect(jobs.seen).toHaveLength(0);
  });

  it("завислий 'pending' старший за 30 хвилин стає failed", async () => {
    addUser("u1", { hour: 20 });
    db.exec("INSERT INTO digest_runs (id, user_id, local_date, status, jobs, created_at) VALUES ('dg_old', 'u1', '2026-09-11', 'pending', 1, datetime('now', '-2 hours'))");
    db.exec("INSERT INTO sent (user_id, job_ref, source, digest_id, position, status) VALUES ('u1', 'nr:x', 'nextrole', 'dg_old', 1, 'pending')");
    db.exec("INSERT INTO digest_runs (id, user_id, local_date, status, jobs) VALUES ('dg_new', 'u1', '2026-09-12', 'pending', 0)");
    await runDigestDue(deps());
    expect(runs()).toEqual([
      { user_id: "u1", local_date: "2026-09-11", status: "failed", jobs: 1, error: INTERRUPTED },
      { user_id: "u1", local_date: "2026-09-12", status: "pending", jobs: 0, error: null },
    ]);
    expect(sent()[0]!.status).toBe("failed");
  });

  it("сухий прогін для однієї людини: показує вибір незалежно від години, нічого не пише й не шле", async () => {
    addUser("u1", { hour: 20 });
    addJobs(6);
    const s = await runDigestDue(deps(), { dryRun: true, userId: "u1" });
    expect(s.dry).toHaveLength(1);
    expect(s.dry[0]!.picks).toHaveLength(5);
    expect(runs()).toHaveLength(0);
    expect(sent()).toHaveLength(0);
    expect(tgCalls).toHaveLength(0);
  });

  it("--user і --profile без --dry-run не працюють", async () => {
    await expect(runDigestDue(deps(), { userId: "u1" })).rejects.toThrow(/dry-run/);
  });
});

describe("CLI digest-due", () => {
  it("--dry-run --profile друкує вибір, базу не чіпає", async () => {
    // CLI бере справжній годинник, тож і вакансії свіжі відносно нього (з NOW тест старів за три доби).
    jobs.close();
    jobs = new FakeJobsDb(new Date());
    addJobs(3);
    const out: string[] = [];
    const code = await runCli(["digest-due", "--dry-run", "--profile", '{"roles":["engineer"],"remote_mode":"remote"}'], {
      env: {}, db: () => db, jobs: () => readOnlyJobsDb(jobs), out: (l) => out.push(l), err: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/profile .*: 3 jobs/);
    expect(out.join("\n")).toMatch(/Senior Solidity Engineer \| Co j0/);
    expect(runs()).toHaveLength(0);
  });

  it("--user без --dry-run = неправильний виклик", async () => {
    const err: string[] = [];
    const code = await runCli(["digest-due", "--user", "u1"], { env: {}, db: () => db, jobs: () => readOnlyJobsDb(jobs), err: (l) => err.push(l) });
    expect(code).toBe(2);
  });
});

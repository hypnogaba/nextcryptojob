// Воронка в добірці (аудит 29.09, F2): кнопки 👍/👎, компанія після 👎, заблокований бот. Поведінка, не сталі.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { DIGEST_MIGRATIONS, SqliteD1 } from "../testing/sqlite-d1.js";
import { readOnlyJobsDb } from "./jobs-db.js";
import { runDigestDue, type DigestDeps } from "./schedule.js";

const NOW = new Date("2026-09-12T05:05:00Z");
let db: SqliteD1;
let jobs: FakeJobsDb;
let tgBodies: Array<Record<string, unknown>>;
let emailBodies: Array<Record<string, unknown>>;
let tgStatus = 200;

const fetchStub = (async (url: string, init: RequestInit) => {
  if (url.includes("api.telegram.org")) {
    tgBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return tgStatus === 200
      ? new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      : new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: tgStatus });
  }
  emailBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
  return new Response(null, { status: 202 });
}) as unknown as typeof fetch;

const deps = (now: Date = NOW): DigestDeps => {
  let n = 0;
  return {
    db, jobs: readOnlyJobsDb(jobs), env: { TELEGRAM_BOT_TOKEN: "t", SITE_URL: "https://nextcryptojob.xyz", INTERNAL_API_SECRET: "s" },
    now: () => now, log: () => undefined, fetchImpl: fetchStub, sleep: async () => undefined, newId: () => `dg_${now.getTime()}_${++n}`,
  };
};

function addUser(id: string, o: { channel?: string; email?: string | null; telegram?: string | null } = {}): void {
  db.exec(
    `INSERT INTO users (id, email, telegram_id, channel, roles, remote_mode, digest_hour, timezone)
     VALUES (?, ?, ?, ?, '["engineer"]', 'remote', 8, 'Europe/Kyiv')`,
    id, o.email === undefined ? `${id}@example.com` : o.email, o.telegram === undefined ? `tg-${id}` : o.telegram, o.channel ?? "telegram");
  db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'engineer', 50, 50, 100, '{}', 'v5')", id);
}

const sentRefs = (user: string) => db.all<{ job_ref: string }>("SELECT job_ref FROM sent WHERE user_id = ? ORDER BY position", user).map((r) => r.job_ref);

beforeEach(() => {
  __resetLimiters();
  db = new SqliteD1(DIGEST_MIGRATIONS);
  jobs = new FakeJobsDb(NOW);
  tgBodies = []; emailBodies = []; tgStatus = 200;
});
afterEach(() => { db.close(); jobs.close(); });

describe("кнопки 👍/👎 у Telegram", () => {
  it("під добіркою рядок кнопок на кожну вакансію, callback несе job_ref", async () => {
    addUser("u1");
    for (let i = 0; i < 3; i++) jobs.add({ id: `j${i}`, title: "Senior Solidity Engineer", company: `Co ${i}` });
    await runDigestDue(deps());
    const markup = tgBodies[0]!.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const refs = sentRefs("u1");
    expect(markup.inline_keyboard).toHaveLength(3);
    markup.inline_keyboard.forEach((row, i) => {
      expect(row.map((b) => b.callback_data)).toEqual([`fb:u:${refs[i]}`, `fb:d:${refs[i]}`]);
      expect(row.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    });
    expect(String(tgBodies[0]!.text)).toContain("Tap");
  });
});

describe("👎 прибирає компанію на 30 днів", () => {
  const addTwoFromSameCompany = () => {
    jobs.add({ id: "a1", title: "Senior Solidity Engineer", company: "Acme Labs" });
    jobs.add({ id: "a2", title: "Senior Rust Engineer", company: "Acme Labs" });
    jobs.add({ id: "b1", title: "Senior Go Engineer", company: "Beta Labs" });
  };
  const vote = (user: string, ref: string, vote: string, at: string, companyKey: string | null) =>
    db.exec("INSERT INTO job_feedback (user_id, job_ref, vote, company_key, at) VALUES (?, ?, ?, ?, ?)", user, ref, vote, companyKey, at);

  it("із записаним company_key: усіх вакансій компанії немає, інші лишаються", async () => {
    addUser("u1");
    addTwoFromSameCompany();
    vote("u1", "nr:earlier-acme-job", "down", "2026-09-05 10:00:00", "acme");
    const s = await runDigestDue(deps());
    expect(s.dislikeFiltered).toBe(1);
    expect(sentRefs("u1")).toEqual(["nr:b1"]);
  });

  it("без company_key компанію знаходимо з пулу за job_ref", async () => {
    addUser("u1");
    addTwoFromSameCompany();
    vote("u1", "nr:a1", "down", "2026-09-05 10:00:00", null);
    await runDigestDue(deps());
    expect(sentRefs("u1")).toEqual(["nr:b1"]);
  });

  it("через 30 днів компанія знову можлива; 👍 нічого не прибирає; чужий 👎 не діє", async () => {
    addUser("u1");
    addUser("u2");
    addTwoFromSameCompany();
    vote("u1", "nr:a1", "down", "2026-08-01 10:00:00", "acme");
    vote("u2", "nr:a1", "up", "2026-09-10 10:00:00", "acme");
    vote("u2", "nr:b1", "down", "2026-09-10 10:00:00", "beta");
    await runDigestDue(deps());
    expect(sentRefs("u1")).toHaveLength(2);
    expect(sentRefs("u1")).toContain("nr:b1");
    // u2: Beta прибрано, Acme лишилась (одна вакансія на компанію).
    expect(sentRefs("u2")).toHaveLength(1);
    expect(sentRefs("u2")[0]).toMatch(/^nr:a[12]$/);
  });

  it("без таблиці job_feedback (міграція ще не накочена) добірка йде як раніше", async () => {
    addUser("u1");
    addTwoFromSameCompany();
    db.exec("DROP TABLE job_feedback");
    const s = await runDigestDue(deps());
    expect(s.sent).toBe(1);
    expect(sentRefs("u1")).toHaveLength(2);
  });
});

describe("заблокований бот і лист", () => {
  const addJobs = () => { for (let i = 0; i < 3; i++) jobs.add({ id: `j${i}`, title: "Senior Solidity Engineer", company: `Co ${i}` }); };
  const notices = () => db.all<{ user_id: string; kind: string; channel: string }>("SELECT user_id, kind, channel FROM nudges");

  it("перший лист замість Telegram каже, чому; наступні дні вже без цього рядка", async () => {
    addUser("u1");
    addJobs();
    tgStatus = 403;
    const day1 = await runDigestDue(deps());
    expect(day1).toMatchObject({ sent: 1, blockedNotices: 1 });
    expect(emailBodies[0]).toMatchObject({ telegram_blocked: true });
    expect(notices()).toEqual([{ user_id: "u1", kind: "tg_blocked_notice", channel: "email" }]);

    for (let i = 3; i < 6; i++) jobs.add({ id: `j${i}`, title: "Senior Solidity Engineer", company: `Co ${i}` });
    const day2 = await runDigestDue(deps(new Date(NOW.getTime() + 86_400_000)));
    expect(day2).toMatchObject({ sent: 1, blockedNotices: 0 });
    expect(emailBodies).toHaveLength(2);
    expect(emailBodies[1]).not.toHaveProperty("telegram_blocked");
    expect(notices()).toHaveLength(1);
  });

  it("позначений раніше, але ще не попереджений: перший лист несе пояснення", async () => {
    addUser("u1");
    db.exec("UPDATE users SET telegram_unreachable_at = datetime('now') WHERE id = 'u1'");
    addJobs();
    const s = await runDigestDue(deps());
    expect(s.blockedNotices).toBe(1);
    expect(emailBodies[0]).toMatchObject({ telegram_blocked: true });
    expect(tgBodies).toHaveLength(0);
  });

  it("людина без Telegram, яка просто вибрала пошту, ніколи не чує про бота", async () => {
    addUser("u1", { channel: "email", telegram: null });
    addJobs();
    await runDigestDue(deps());
    expect(emailBodies[0]).not.toHaveProperty("telegram_blocked");
    expect(notices()).toEqual([]);
  });
});

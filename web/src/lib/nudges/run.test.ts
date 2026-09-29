import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runNudges, widenOptions } from "./run";
import { answerStillLooking } from "./still-looking";

/**
 * Повідомлення воронки (аудит 29.09, F1, F3, F4). Перевіряємо поведінку: кому пішло, коли, скільки разів,
 * що відбулось без відповіді і як людина зупиняє розсилку.
 */

// 12:00 UTC: удень і в Європі, і в Америці.
const NOW = new Date("2026-09-29T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

let db: TestDb;
let tg: Array<{ chat_id: string; text: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } }>;
let mail: Array<{ to: string; subject: string; text: string; html: string; headers?: Record<string, string> }>;
let tgStatus = 200;

const notifier = () => ({
  botToken: "tok",
  mailer: { send: async (m: (typeof mail)[number]) => void mail.push(m) },
  origin: "https://nextcryptojob.xyz",
  send: {
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (tgStatus === 200) {
        tg.push(body);
        return Response.json({ ok: true, result: {} });
      }
      return Response.json({ ok: false, description: tgStatus === 403 ? "Forbidden: bot was blocked by the user" : "Internal" }, { status: tgStatus });
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
  },
});

const go = (now: Date = NOW) => runNudges(db.d1, { env: { SESSION_SECRET: "k".repeat(32) }, notifier: notifier(), now });

type U = {
  id: string; email?: string | null; telegram?: string | null; channel?: string; roles?: string; step?: string | null; tz?: string;
  created?: string; active?: string; paused?: number; remoteMode?: string;
};
function user(u: U): void {
  run(
    db.raw,
    `INSERT INTO users (id, email, telegram_id, channel, roles, onboarding_step, timezone, created_at, last_active_at, digest_paused, remote_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    u.id, u.email === undefined ? null : u.email, u.telegram === undefined ? `tg-${u.id}` : u.telegram, u.channel ?? "telegram",
    u.roles ?? "[]", u.step ?? null, u.tz ?? "UTC", u.created ?? ago(40), u.active ?? ago(40), u.paused ?? 0, u.remoteMode ?? "remote",
  );
}
/** Добірка доставлена вчора: людина її отримує. */
const digestSent = (id: string, daysAgo = 1) =>
  run(db.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, created_at) VALUES (?, ?, ?, 'sent', 5, ?)", `dg_${id}_${daysAgo}`, id, ago(daysAgo).slice(0, 10), ago(daysAgo));
const digestEmpty = (id: string, daysAgo: number) =>
  run(db.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, created_at) VALUES (?, ?, ?, 'empty', 0, ?)", `de_${id}_${daysAgo}`, id, ago(daysAgo).slice(0, 10), ago(daysAgo));
const nudges = (kind?: string) =>
  all<{ user_id: string; kind: string; channel: string | null; answered_at: string | null }>(
    db.raw, `SELECT user_id, kind, channel, answered_at FROM nudges ${kind ? "WHERE kind = ?" : ""} ORDER BY id`, ...(kind ? [kind] : []));

beforeEach(() => {
  db = crmDb();
  tg = []; mail = []; tgStatus = 200;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("F1: нагадування тому, хто зупинився на першому кроці", () => {
  it("через добу одне нагадування питає прямо, вдруге не пише ніколи", async () => {
    user({ id: "u1", created: hoursAgo(30) });
    expect(await go()).toMatchObject({ onboardingReminders: 1 });
    expect(tg).toHaveLength(1);
    expect(tg[0]!.text).toContain("write here what work you are looking for");
    expect(tg[0]!.text).toContain("/stop");
    expect(nudges()).toEqual([{ user_id: "u1", kind: "onboarding_reminder", channel: "telegram", answered_at: null }]);

    // Усі наступні запуски, навіть за місяць: рядок є, унікальний індекс не дає другого.
    await go();
    await go(new Date(NOW.getTime() + 20 * 86_400_000));
    expect(tg).toHaveLength(1);
  });

  it("не раніше, ніж за добу; не тим, хто вже в анкеті далі, на паузі чи давно пішов", async () => {
    user({ id: "fresh", created: hoursAgo(10) });
    user({ id: "done", created: hoursAgo(30), step: "done", roles: '["engineer"]' });
    user({ id: "paused", created: hoursAgo(30), paused: 1 });
    user({ id: "ancient", created: ago(90) });
    user({ id: "emailonly", created: hoursAgo(30), telegram: null, email: "e@example.com", channel: "email" });
    expect(await go()).toMatchObject({ onboardingReminders: 0 });
    expect(tg).toEqual([]);
    expect(mail).toEqual([]);
  });

  it("людина з ролями, але без другого кроку, отримує посилання доробити", async () => {
    user({ id: "u1", created: hoursAgo(30), roles: '["engineer"]', step: "place" });
    await go();
    expect(tg[0]!.text).toContain("/welcome?step=place");
  });

  it("вночі за часом людини не пишемо, а наступного дня так", async () => {
    user({ id: "tokyo", created: hoursAgo(30), tz: "Asia/Tokyo" }); // 21:00
    expect(await go()).toMatchObject({ onboardingReminders: 0 });
    // 18:00 UTC = 03:00 в Токіо; 00:00 UTC наступного дня = 09:00.
    expect(await go(new Date("2026-09-30T00:00:00Z"))).toMatchObject({ onboardingReminders: 1 });
  });

  it("не дійшло: замок знімається й наступна година пробує знову; заблокований бот позначається недосяжним", async () => {
    user({ id: "u1", created: hoursAgo(30) });
    tgStatus = 500;
    expect(await go()).toMatchObject({ onboardingReminders: 0, failed: 1 });
    expect(nudges()).toEqual([]);
    tgStatus = 403;
    await go();
    expect(all(db.raw, "SELECT telegram_unreachable_at AS at FROM users WHERE id = 'u1'")[0]!.at).not.toBeNull();
    // Недосяжного більше не питаємо, і пошти в нього немає: тихо.
    tgStatus = 200;
    expect(await go()).toMatchObject({ onboardingReminders: 0, failed: 0 });
    expect(tg).toEqual([]);
  });
});

describe("F3: «Still looking?» і пауза після тиші", () => {
  it("14 днів тиші при живих добірках: одне питання з кнопкою Yes, у ньому сказано про паузу", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(20) });
    digestSent("u1");
    expect(await go()).toMatchObject({ stillLooking: 1 });
    expect(tg).toHaveLength(1);
    expect(tg[0]!.text).toContain("Still looking");
    expect(tg[0]!.text).toContain("pause them");
    expect(tg[0]!.text).toContain("/stop");
    expect(tg[0]!.reply_markup!.inline_keyboard[0]![0]).toMatchObject({ callback_data: "sl:y" });

    // Не частіше разу на 30 днів.
    await go(new Date(NOW.getTime() + 3600_000));
    await go(new Date(NOW.getTime() + 10 * 86_400_000));
    expect(tg).toHaveLength(1);
  });

  it("не питаємо активних, тих, хто голосував, на паузі, без добірок і нових", async () => {
    user({ id: "active", roles: '["engineer"]', active: ago(5) });
    digestSent("active");
    user({ id: "voter", roles: '["engineer"]', active: ago(20) });
    digestSent("voter");
    run(db.raw, "INSERT INTO job_feedback (user_id, job_ref, vote, at) VALUES ('voter', 'nr:1', 'up', ?)", ago(3));
    user({ id: "paused", roles: '["engineer"]', active: ago(20), paused: 1 });
    digestSent("paused");
    user({ id: "nodigest", roles: '["engineer"]', active: ago(20) });
    user({ id: "newcomer", roles: '["engineer"]', created: ago(5), active: ago(5) });
    digestSent("newcomer");
    expect(await go()).toMatchObject({ stillLooking: 0 });
    expect(tg).toEqual([]);
  });

  it("людина з поштою отримує лист із підписаною кнопкою Yes і відпискою", async () => {
    user({ id: "m1", roles: '["engineer"]', active: ago(20), telegram: null, email: "m1@example.com", channel: "email" });
    digestSent("m1");
    await go();
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: "m1@example.com", subject: "Still looking for a crypto job?" });
    expect(mail[0]!.html).toContain("/api/digest/still-looking?u=m1&amp;t=");
    expect(mail[0]!.text).toContain("Pause daily jobs:");
    expect(mail[0]!.headers?.["List-Unsubscribe"]).toContain("/api/digest/unsubscribe");
    expect(tg).toEqual([]);
  });

  it("без відповіді за 3 дні добірка на паузі; з відповіддю чи активністю ні", async () => {
    user({ id: "silent", roles: '["engineer"]', active: ago(25) });
    user({ id: "yes", roles: '["engineer"]', active: ago(25) });
    user({ id: "back", roles: '["engineer"]', active: ago(1) });
    for (const id of ["silent", "yes", "back"]) {
      run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES (?, 'still_looking', 'telegram', ?)", id, ago(4));
    }
    run(db.raw, "UPDATE nudges SET answered_at = ? WHERE user_id = 'yes'", ago(3));
    expect(await go()).toMatchObject({ inactivePaused: 1 });
    const paused = all<{ id: string; digest_paused: number }>(db.raw, "SELECT id, digest_paused FROM users ORDER BY id");
    expect(paused).toEqual([
      { id: "back", digest_paused: 0 },
      { id: "silent", digest_paused: 1 },
      { id: "yes", digest_paused: 0 },
    ]);
    expect(nudges("inactive_pause")).toEqual([{ user_id: "silent", kind: "inactive_pause", channel: null, answered_at: null }]);
    // Повторний запуск не ставить паузу вдруге.
    expect(await go()).toMatchObject({ inactivePaused: 0 });
  });

  it("тап «Yes» за 2 дні до паузи лишає добірку, а пізній тап після паузи знімає її", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(25) });
    run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES ('u1', 'still_looking', 'telegram', ?)", ago(2));
    expect(await answerStillLooking(db.d1, "u1")).toBe(true);
    expect(await go()).toMatchObject({ inactivePaused: 0 });

    user({ id: "u2", roles: '["engineer"]', active: ago(25) });
    run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES ('u2', 'still_looking', 'telegram', ?)", ago(5));
    await go();
    expect(all(db.raw, "SELECT digest_paused AS p FROM users WHERE id = 'u2'")[0]!.p).toBe(1);
    expect(await answerStillLooking(db.d1, "u2")).toBe(true);
    expect(all(db.raw, "SELECT digest_paused AS p FROM users WHERE id = 'u2'")[0]!.p).toBe(0);
    // Відповіді немає що закривати вдруге.
    expect(await answerStillLooking(db.d1, "u2")).toBe(false);
  });

  it("пауза, яку людина поставила сама, від «Yes» не знімається", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(1), paused: 1 });
    run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES ('u1', 'still_looking', 'telegram', ?)", ago(2));
    await answerStillLooking(db.d1, "u1");
    expect(all(db.raw, "SELECT digest_paused AS p FROM users WHERE id = 'u1'")[0]!.p).toBe(1);
  });
});

describe("F4: порожній тиждень", () => {
  it("3+ порожніх дні: одне повідомлення зі способами розширити, раз на тиждень", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(1), remoteMode: "city" });
    for (const d of [1, 2, 3]) digestEmpty("u1", d);
    expect(await go()).toMatchObject({ emptyWeek: 1 });
    expect(tg).toHaveLength(1);
    expect(tg[0]!.text).toContain("No new jobs fit you this week");
    const buttons = tg[0]!.reply_markup!.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toEqual(["Add remote jobs", "Change your city", "Add another role"]);
    expect(tg[0]!.reply_markup!.inline_keyboard[0]![0]!.url).toContain("/welcome?step=place");

    await go(new Date(NOW.getTime() + 3600_000));
    await go(new Date(NOW.getTime() + 5 * 86_400_000));
    expect(tg).toHaveLength(1);
  });

  it("минув тиждень від попереднього: можна знову", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(1) });
    for (const d of [1, 2, 3]) digestEmpty("u1", d);
    run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES ('u1', 'empty_week', 'telegram', ?)", ago(8));
    expect(await go()).toMatchObject({ emptyWeek: 1 });
  });

  it("два порожні дні, пауза чи хтось без каналу: нічого", async () => {
    user({ id: "two", roles: '["engineer"]' });
    for (const d of [1, 2]) digestEmpty("two", d);
    user({ id: "paused", roles: '["engineer"]', paused: 1 });
    for (const d of [1, 2, 3]) digestEmpty("paused", d);
    user({ id: "old", roles: '["engineer"]' });
    for (const d of [8, 9, 10]) digestEmpty("old", d);
    expect(await go()).toMatchObject({ emptyWeek: 0 });
    expect(tg).toEqual([]);
  });

  it("лист: канал людини, відписка, кнопка", async () => {
    user({ id: "m1", roles: '["engineer","trader","designer"]', telegram: null, email: "m1@example.com", channel: "email", remoteMode: "remote" });
    for (const d of [1, 2, 3]) digestEmpty("m1", d);
    await go();
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: "m1@example.com", subject: "No new jobs fit you this week" });
    expect(mail[0]!.text).toContain("Pause daily jobs:");
    // Удаленка вже є, ролей три: лишається одна порада.
    expect(mail[0]!.text).toContain("Review your roles and place");
    expect(mail[0]!.text).not.toContain("Add remote jobs");
  });

  it("не пише вдруге поспіль після «Still looking?»", async () => {
    user({ id: "u1", roles: '["engineer"]', active: ago(1) });
    for (const d of [1, 2, 3]) digestEmpty("u1", d);
    run(db.raw, "INSERT INTO nudges (user_id, kind, channel, sent_at) VALUES ('u1', 'still_looking', 'telegram', ?)", hoursAgo(5));
    expect(await go()).toMatchObject({ emptyWeek: 0 });
  });

  it("поради лише ті, що щось дають", () => {
    const site = "https://nextcryptojob.xyz";
    expect(widenOptions({ roles: '["engineer"]', remote_mode: "city" }, site).map((o) => o.label)).toEqual([
      "Add remote jobs", "Change your city", "Add another role",
    ]);
    expect(widenOptions({ roles: '["engineer"]', remote_mode: "remote" }, site).map((o) => o.label)).toEqual(["Add another role"]);
    expect(widenOptions({ roles: '["engineer","bd","trader"]', remote_mode: "remote,city" }, site).map((o) => o.label)).toEqual(["Change your city"]);
  });
});

describe("зупинка", () => {
  it("кожне повідомлення каже, як зупинитись: /stop у Telegram, відписка в листі", async () => {
    user({ id: "t1", created: hoursAgo(30) });
    user({ id: "t2", roles: '["engineer"]', active: ago(20) });
    digestSent("t2");
    user({ id: "t3", roles: '["engineer"]' });
    for (const d of [1, 2, 3]) digestEmpty("t3", d);
    await go();
    expect(tg.length).toBeGreaterThanOrEqual(3);
    for (const m of tg) expect(m.text).toContain("/stop");
  });
});

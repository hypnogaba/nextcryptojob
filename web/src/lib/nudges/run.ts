import { deliver, notifierFromEnv, type Notifier, type NotifyEnv, type OutgoingMessage, type Recipient } from "@/lib/crm/notify";
import { unsubscribeKey, unsubscribeUrl } from "@/lib/digest/unsubscribe";
import { emptyWeekEmail, onboardingReminderEmail, stillLookingEmail } from "@/lib/mail/nudge";
import { parseRoles } from "@/lib/roles/catalog";
import { escapeHtml } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";
import { stillLookingUrl } from "./still-looking";

/**
 * Службові повідомлення воронки (аудит 29.09, розділ F). Щогодини з cron (cron/index.ts, задача nudges.send):
 *
 * - F1 onboarding_reminder: людина з Telegram не закінчила анкету, минула доба: одне нагадування, ніколи двох
 *   (унікальний індекс nudges, 0028).
 * - F3 still_looking: 14 днів без входу на сайт, без відгуку й без слова боту, а добірки при цьому йдуть:
 *   одне «Still looking?» з кнопкою «Yes», не частіше разу на 30 днів. Без відповіді за 3 дні добірка
 *   ставиться на паузу (inactive_pause), у повідомленні про це сказано наперед.
 * - F4 empty_week: 3+ порожніх дні з останніх 7: раз на тиждень «No new jobs fit you this week» і способи розширити.
 *
 * Кожне повідомлення: лише людям без паузи (відписка й /stop = пауза), лише в їхній канал (Telegram першим,
 * якщо це канал, пошта запасом), вдень за їхнім часом (NUDGE_FROM_HOUR..NUDGE_TO_HOUR), і кожне має спосіб
 * зупинитись: /stop у Telegram, «Pause daily jobs» у листі. Рядок nudges береться ДО відправки (замок від
 * двох запусків), а якщо доставка не вдалась, знімається, і наступна година спробує знову.
 */

export const ONBOARDING_REMIND_AFTER_HOURS = 24;
/** Старіші за це анкети не нагадуємо: нагадування про місяць тому вже не «нагадування». */
export const ONBOARDING_MAX_AGE_DAYS = 30;
export const STILL_LOOKING_AFTER_DAYS = 14;
export const STILL_LOOKING_REPEAT_DAYS = 30;
export const PAUSE_AFTER_DAYS = 3;
export const EMPTY_DAYS_NEEDED = 3;
export const EMPTY_WINDOW_DAYS = 7;
export const EMPTY_REPEAT_DAYS = 7;
/** Повідомлення воронки лише вдень за часом людини. */
export const NUDGE_FROM_HOUR = 9;
export const NUDGE_TO_HOUR = 20;
/** Не більше повідомлень одного виду за запуск: розсилка не має бути раптовою. */
export const PER_RUN_LIMIT = 20;
const CANDIDATE_LIMIT = 200;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type NudgeKind = "onboarding_reminder" | "still_looking" | "inactive_pause" | "empty_week" | "tg_blocked_notice";

export type NudgeEnv = NotifyEnv & { SESSION_SECRET?: string; INTERNAL_API_SECRET?: string };

export interface NudgeOptions {
  env?: NudgeEnv;
  notifier?: Notifier;
  now?: Date;
  /** Після цієї миті (мс) нових повідомлень не беремо. */
  deadline?: number;
  limit?: number;
}

type Person = {
  id: string;
  channel: "email" | "telegram";
  telegram_id: string | null;
  email: string | null;
  timezone: string | null;
  telegram_unreachable_at: string | null;
  roles: string;
  remote_mode: string | null;
  onboarding_step: string | null;
};

const PERSON = `u.id, u.channel, u.telegram_id, u.email, u.timezone, u.telegram_unreachable_at, u.roles, u.remote_mode, u.onboarding_step`;
/** Є куди писати: пошта або Telegram, який не позначено недосяжним. */
const REACHABLE = `(u.email IS NOT NULL OR (u.telegram_id IS NOT NULL AND u.telegram_unreachable_at IS NULL))`;
const ACTIVE = `COALESCE(u.digest_paused, 0) = 0 AND u.is_demo = 0`;

// ---------------- вибірки ----------------

/** F1: Telegram, анкету не закінчено, минула доба, ще без нагадування, добірка не починалась. */
export const ONBOARDING_SQL = `SELECT ${PERSON} FROM users u
  WHERE u.telegram_id IS NOT NULL AND ${ACTIVE} AND ${REACHABLE}
    AND COALESCE(u.onboarding_step, '') NOT IN ('x', 'wallets', 'sources', 'done')
    AND u.created_at <= ?1 AND u.created_at > ?2
    AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.id AND n.kind = 'onboarding_reminder')
    AND NOT EXISTS (SELECT 1 FROM digest_runs r WHERE r.user_id = u.id)
  ORDER BY u.created_at LIMIT ?3`;

/**
 * F3: добірки йдуть (sent за 3 дні), а людина мовчить 14 днів: не входила (last_active_at, який ставить і сесія
 * сайту, і слово боту, і відгук), не голосувала, не відповідала. Питали вже за 30 днів: не питаємо.
 * Кліки по вакансіях сюди не входять: apply_click_seen без людини (лише ключ IP+вакансія), а сторінка вакансії відкрита без входу.
 */
export const STILL_LOOKING_SQL = `SELECT ${PERSON} FROM users u
  WHERE u.roles <> '[]' AND ${ACTIVE} AND ${REACHABLE}
    AND u.created_at <= ?1 AND u.last_active_at <= ?1
    AND EXISTS (SELECT 1 FROM digest_runs r WHERE r.user_id = u.id AND r.status = 'sent' AND r.created_at > ?2)
    AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.user_id = u.id AND f.at > ?1)
    AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.id AND n.kind = 'still_looking' AND n.sent_at > ?3)
  ORDER BY u.last_active_at LIMIT ?4`;

/** Пауза після тиші: питали 3+ дні тому, відповіді немає, від питання людина нічого не робила. */
export const AUTO_PAUSE_SQL = `SELECT u.id, n.sent_at FROM users u JOIN nudges n ON n.user_id = u.id AND n.kind = 'still_looking'
  WHERE n.answered_at IS NULL AND n.sent_at <= ?1 AND COALESCE(u.digest_paused, 0) = 0
    AND u.last_active_at <= n.sent_at
    AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.user_id = u.id AND f.at > n.sent_at)
    AND NOT EXISTS (SELECT 1 FROM nudges p WHERE p.user_id = u.id AND p.kind = 'inactive_pause' AND p.sent_at > n.sent_at)
  ORDER BY n.sent_at LIMIT ?2`;

/**
 * F4: три порожні дні і більше з останніх семи, за тиждень ще не писали. Добу після питання «Still looking?»
 * чи нагадування не пишемо: не два повідомлення поспіль.
 */
export const EMPTY_WEEK_SQL = `SELECT ${PERSON} FROM users u
  WHERE u.roles <> '[]' AND ${ACTIVE} AND ${REACHABLE}
    AND (SELECT COUNT(*) FROM digest_runs r WHERE r.user_id = u.id AND r.status = 'empty' AND r.local_date >= ?1) >= ?2
    AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.id AND n.kind = 'empty_week' AND n.sent_at > ?3)
    AND NOT EXISTS (SELECT 1 FROM nudges n WHERE n.user_id = u.id AND n.kind IN ('still_looking', 'onboarding_reminder') AND n.sent_at > ?4)
  ORDER BY u.id LIMIT ?5`;

// ---------------- час людини ----------------

/** Година 0-23 у поясі людини; невідомий пояс = UTC. */
export function localHourOf(at: Date, timezone: string | null | undefined): number {
  const tz = timezone?.trim() || "UTC";
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).formatToParts(at).find((p) => p.type === "hour")?.value;
    return Number(h) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/** Чи зараз у людини вдень: не будимо повідомленням. */
export function isDaytime(at: Date, timezone: string | null | undefined): boolean {
  const h = localHourOf(at, timezone);
  return h >= NUDGE_FROM_HOUR && h < NUDGE_TO_HOUR;
}

// ---------------- відправка ----------------

const recipientOf = (p: Person, canEmail: boolean): Recipient => ({
  channel: p.channel,
  // Telegram, який позначено недосяжним, не питаємо.
  telegramId: p.telegram_unreachable_at ? null : p.telegram_id,
  email: canEmail ? p.email : null,
});

/** Telegram сказав, що людину не досягти: запам'ятати, як робить добірка (engine), щоб не бити щогодини. */
async function noteUnreachable(d: D1Database, userId: string, error: string): Promise<void> {
  if (!/telegram:.*(blocked|chat not found|user is deactivated|forbidden)/i.test(error)) return;
  await d.prepare("UPDATE users SET telegram_unreachable_at = datetime('now') WHERE id = ? AND telegram_unreachable_at IS NULL").bind(userId).run();
}

/**
 * Замок «не більше разу за вікно»: рядок nudges з'являється, лише якщо за вікно такого ще не було.
 * id рядка, або null, якщо інший запуск устиг першим.
 */
async function claim(d: D1Database, userId: string, kind: NudgeKind, since: string): Promise<number | null> {
  try {
    const row = await d
      .prepare(
        `INSERT INTO nudges (user_id, kind) SELECT ?1, ?2
          WHERE NOT EXISTS (SELECT 1 FROM nudges WHERE user_id = ?1 AND kind = ?2 AND sent_at > ?3)
         RETURNING id`,
      )
      .bind(userId, kind, since)
      .first<{ id: number }>();
    return row?.id ?? null;
  } catch (err) {
    // Унікальний індекс (onboarding_reminder): хтось уже записав.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return null;
    throw err;
  }
}

async function send(
  d: D1Database, n: Notifier, p: Person, kind: NudgeKind, since: string, message: OutgoingMessage, canEmail: boolean,
): Promise<"sent" | "failed" | "taken"> {
  const id = await claim(d, p.id, kind, since);
  if (id === null) return "taken";
  const res = await deliver(recipientOf(p, canEmail), message, n);
  if (res.ok) {
    await d.prepare("UPDATE nudges SET channel = ? WHERE id = ?").bind(res.channel, id).run();
    return "sent";
  }
  // Не дійшло: знімаємо замок, наступна година спробує знову (а недосяжного Telegram більше не питаємо).
  await d.prepare("DELETE FROM nudges WHERE id = ?").bind(id).run();
  await noteUnreachable(d, p.id, res.error);
  console.warn(`nudges: ${kind} not delivered to ${p.id}: ${res.error}`);
  return "failed";
}

// ---------------- тексти ----------------

const stopHint = "/stop pauses these messages.";

function onboardingMessage(p: Person, site: string, unsubscribe: string | null): OutgoingMessage {
  const noRoles = parseRoles(p.roles).length === 0;
  const finish = new URL(noRoles ? "/welcome?step=roles" : "/welcome?step=place", site).toString();
  const telegramHtml = noRoles
    ? "Still want crypto jobs that fit you?\nJust write here what work you are looking for, in your own words.\n\n" + stopHint
    : `Your setup is almost done. Two short steps are left: where you want to work and how to get your jobs.\n\n<a href="${escapeHtml(finish)}">Finish setup</a>\n\n${stopHint}`;
  return {
    telegramHtml,
    email: onboardingReminderEmail({ site, unsubscribeUrl: unsubscribe ?? new URL("/settings", site).toString(), startUrl: finish }),
  };
}

function stillLookingMessage(site: string, unsubscribe: string, yesUrl: string): OutgoingMessage {
  const settings = new URL("/settings", site).toString();
  return {
    telegramHtml:
      "Still looking for a crypto job?\nYou have not opened NextCryptoJob for two weeks. Tap Yes to keep your daily jobs.\n\n" +
      `If we hear nothing in 3 days, we pause them. You can turn them back on in <a href="${escapeHtml(settings)}">settings</a>, or send /start here.\n\n${stopHint}`,
    replyMarkup: { inline_keyboard: [[{ text: "Yes, keep them coming", callback_data: "sl:y" }]] },
    email: stillLookingEmail({ site, unsubscribeUrl: unsubscribe, yesUrl }),
  };
}

/** Способи розширити пошук: лише ті, що людині справді дають щось нове. */
export function widenOptions(p: Pick<Person, "roles" | "remote_mode">, site: string): Array<{ label: string; url: string }> {
  const place = new URL("/welcome?step=place", site).toString();
  const rolesUrl = new URL("/welcome?step=roles", site).toString();
  const modes = (p.remote_mode ?? "").split(",").map((m) => m.trim());
  const out: Array<{ label: string; url: string }> = [];
  if (!modes.includes("remote")) out.push({ label: "Add remote jobs", url: place });
  if (modes.includes("city")) out.push({ label: "Change your city", url: place });
  if (parseRoles(p.roles).length < 3) out.push({ label: "Add another role", url: rolesUrl });
  if (out.length === 0) out.push({ label: "Review your roles and place", url: rolesUrl });
  return out;
}

function emptyWeekMessage(p: Person, site: string, unsubscribe: string): OutgoingMessage {
  const options = widenOptions(p, site);
  const settings = new URL("/settings", site).toString();
  return {
    telegramHtml:
      "No new jobs fit you this week.\nWe looked every day, and nothing matched your roles and place. You can widen your search:\n\n" +
      `Daily jobs settings: <a href="${escapeHtml(settings)}">open settings</a>.\n${stopHint}`,
    replyMarkup: { inline_keyboard: options.map((o) => [{ text: o.label, url: o.url }]) },
    email: emptyWeekEmail({ site, unsubscribeUrl: unsubscribe, options }),
  };
}

// ---------------- запуск ----------------

export type NudgeCounts = {
  onboardingReminders: number;
  stillLooking: number;
  inactivePaused: number;
  emptyWeek: number;
  failed: number;
};

export async function runNudges(d: D1Database, o: NudgeOptions = {}): Promise<NudgeCounts> {
  const now = o.now ?? new Date();
  const env = o.env ?? {};
  const n = o.notifier ?? notifierFromEnv(env);
  const site = n.origin;
  const key = unsubscribeKey(env);
  const limit = o.limit ?? PER_RUN_LIMIT;
  const deadline = o.deadline ?? Infinity;
  const at = (ms: number) => sqlTime(new Date(now.getTime() - ms));
  const out: NudgeCounts = { onboardingReminders: 0, stillLooking: 0, inactivePaused: 0, emptyWeek: 0, failed: 0 };
  const canRun = () => Date.now() < deadline;
  const tally = (r: "sent" | "failed" | "taken", field: keyof NudgeCounts) => {
    if (r === "sent") out[field]++;
    else if (r === "failed") out.failed++;
  };
  /** Лист без підписаного посилання відписки не шлемо: людина мусить мати спосіб зупинитись. */
  const unsub = async (p: Person): Promise<string | null> => (key ? unsubscribeUrl(site, key, p.id) : null);

  // 1. Пауза після тиші: найважливіше й найдешевше, тому першим.
  const stale = await d.prepare(AUTO_PAUSE_SQL).bind(at(PAUSE_AFTER_DAYS * DAY_MS), CANDIDATE_LIMIT).all<{ id: string; sent_at: string }>();
  for (const row of stale.results) {
    const paused = await d.prepare("UPDATE users SET digest_paused = 1 WHERE id = ? AND digest_paused = 0").bind(row.id).run();
    if (paused.meta.changes !== 1) continue;
    await d.prepare("INSERT INTO nudges (user_id, kind) VALUES (?, 'inactive_pause')").bind(row.id).run();
    // Журнал дій напряму в переданій базі: у cron немає контексту запиту, а audit() бере базу з нього.
    await d
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, 'digest.inactive_pause', ?, ?)")
      .bind(row.id, row.id, JSON.stringify({ digest_paused: true }))
      .run();
    out.inactivePaused++;
  }

  // 2. F1: нагадування тому, хто не закінчив анкету.
  const onboarding = await d
    .prepare(ONBOARDING_SQL)
    .bind(at(ONBOARDING_REMIND_AFTER_HOURS * HOUR_MS), at(ONBOARDING_MAX_AGE_DAYS * DAY_MS), CANDIDATE_LIMIT)
    .all<Person>();
  let sentNow = 0;
  for (const p of onboarding.results) {
    if (sentNow >= limit || !canRun()) break;
    if (!isDaytime(now, p.timezone)) continue;
    const unsubscribe = await unsub(p);
    // Вікно замка: назавжди (унікальний індекс) → рядок «1970».
    const r = await send(d, n, p, "onboarding_reminder", "1970-01-01 00:00:00", onboardingMessage(p, site, unsubscribe), !!unsubscribe);
    tally(r, "onboardingReminders");
    if (r !== "taken") sentNow++;
  }

  // 3. F3: «Still looking?».
  sentNow = 0;
  const quiet = await d
    .prepare(STILL_LOOKING_SQL)
    .bind(at(STILL_LOOKING_AFTER_DAYS * DAY_MS), at(3 * DAY_MS), at(STILL_LOOKING_REPEAT_DAYS * DAY_MS), CANDIDATE_LIMIT)
    .all<Person>();
  for (const p of quiet.results) {
    if (sentNow >= limit || !canRun()) break;
    if (!isDaytime(now, p.timezone)) continue;
    const unsubscribe = await unsub(p);
    // Без ключа підписів лист «Yes» не зібрати: лишається лише Telegram.
    const yes = key ? await stillLookingUrl(site, key, p.id) : null;
    const canEmail = !!unsubscribe && !!yes;
    const message = stillLookingMessage(site, unsubscribe ?? "", yes ?? "");
    const r = await send(d, n, p, "still_looking", at(STILL_LOOKING_REPEAT_DAYS * DAY_MS), message, canEmail);
    tally(r, "stillLooking");
    if (r !== "taken") sentNow++;
  }

  // 4. F4: порожній тиждень.
  sentNow = 0;
  const emptyFrom = new Date(now.getTime() - EMPTY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const empty = await d
    .prepare(EMPTY_WEEK_SQL)
    .bind(emptyFrom, EMPTY_DAYS_NEEDED, at(EMPTY_REPEAT_DAYS * DAY_MS), at(2 * DAY_MS), CANDIDATE_LIMIT)
    .all<Person>();
  for (const p of empty.results) {
    if (sentNow >= limit || !canRun()) break;
    if (!isDaytime(now, p.timezone)) continue;
    const unsubscribe = await unsub(p);
    const r = await send(d, n, p, "empty_week", at(EMPTY_REPEAT_DAYS * DAY_MS), emptyWeekMessage(p, site, unsubscribe ?? ""), !!unsubscribe);
    tally(r, "emptyWeek");
    if (r !== "taken") sentNow++;
  }
  return out;
}

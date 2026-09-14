import { consentChange, consentState, CONTACT_CONSENT, SCORING_BASIS_SQL, TERMS_ACCEPTANCE, VISIBILITY_CONSENT } from "@/lib/consent";
import type { Channel } from "@/lib/telegram/channel";
import { notifyCrmVisibility } from "./hooks";
import { canonicalTimezone } from "./timezones";

/**
 * Налаштування людини: щоденні вакансії, видимість для компаній, спосіб
 * контакту. Кожна зміна згоди пишеться разом зі станом у одному DB.batch
 * (docs/contracts.md, розділ 9): прапор у users, consents і consent_events
 * або змінюються разом, або ніхто.
 */

export type { Channel };
export type ContactMode = "approval" | "direct";

export type Settings = {
  email: string | null;
  telegramLinked: boolean;
  telegramHandle: string | null;
  channel: Channel;
  digestHour: number;
  timezone: string | null;
  digestPaused: boolean;
  /** Видимий для компаній: прапор і чинна згода разом (правило CRM, розділ 3.4). */
  visible: boolean;
  contactMode: ContactMode;
  scoringConsent: boolean;
};

type Row = {
  email: string | null;
  telegram_id: string | null;
  telegram_username: string | null;
  channel: Channel;
  digest_hour: number;
  timezone: string | null;
  digest_paused: number;
  visible_to_companies: number;
  contact_mode: ContactMode;
  visibility: number | null;
  scoring: number | null;
};

async function loadRow(d: D1Database, userId: string): Promise<Row | null> {
  return d
    .prepare(
      `SELECT u.email, u.telegram_id, u.telegram_username, u.channel, u.digest_hour, u.timezone,
              u.digest_paused, u.visible_to_companies, u.contact_mode,
              (SELECT granted FROM consents WHERE user_id = u.id AND kind = ?2) AS visibility,
              (SELECT MAX(granted) FROM consents WHERE user_id = u.id AND kind IN ${SCORING_BASIS_SQL}) AS scoring
         FROM users u WHERE u.id = ?1`,
    )
    .bind(userId, VISIBILITY_CONSENT.kind)
    .first<Row>();
}

export async function loadSettings(d: D1Database, userId: string): Promise<Settings | null> {
  const row = await loadRow(d, userId);
  if (!row) return null;
  return {
    email: row.email,
    telegramLinked: row.telegram_id !== null,
    telegramHandle: row.telegram_username,
    channel: row.channel,
    digestHour: row.digest_hour,
    timezone: row.timezone,
    digestPaused: row.digest_paused === 1,
    visible: row.visible_to_companies === 1 && row.visibility === 1,
    contactMode: row.contact_mode,
    scoringConsent: row.scoring === 1,
  };
}

// --- Щоденні вакансії ---------------------------------------------------------

export type DailyJobsInput = { channel: unknown; hour: unknown; timezone: unknown; paused: unknown };
export type DailyJobs = { channel: Channel; hour: number; timezone: string; paused: boolean };
export type DailyJobsResult = { ok: true; value: DailyJobs } | { ok: false; errors: Record<string, string> };

/** Перевіряє форму «Daily jobs». Канал лише той, куди справді можна надіслати. */
export function validateDailyJobs(
  input: DailyJobsInput,
  can: { email: boolean; telegram: boolean },
): DailyJobsResult {
  const errors: Record<string, string> = {};

  let channel: Channel | null = null;
  if (input.channel === "email") {
    if (can.email) channel = "email";
    else errors.channel = "Add an email address first.";
  } else if (input.channel === "telegram") {
    if (can.telegram) channel = "telegram";
    else errors.channel = "Connect Telegram first.";
  } else {
    errors.channel = "Choose where to get your jobs.";
  }

  const hourText = typeof input.hour === "string" ? input.hour.trim() : "";
  const hour = /^\d{1,2}$/.test(hourText) ? Number(hourText) : NaN;
  if (!(hour >= 0 && hour <= 23)) errors.hour = "Choose an hour from 00:00 to 23:00.";

  const timezone = canonicalTimezone(input.timezone);
  if (!timezone) errors.timezone = "Choose a time zone from the list.";

  const paused = input.paused === "on" || input.paused === "yes" || input.paused === "1";

  if (Object.keys(errors).length > 0 || !channel || !timezone) return { ok: false, errors };
  return { ok: true, value: { channel, hour, timezone, paused } };
}

export async function saveDailyJobs(d: D1Database, userId: string, v: DailyJobs): Promise<void> {
  await d
    .prepare("UPDATE users SET channel = ?, digest_hour = ?, timezone = ?, digest_paused = ? WHERE id = ?")
    .bind(v.channel, v.hour, v.timezone, v.paused ? 1 : 0, userId)
    .run();
}

/**
 * Пояс з браузера під час першого візиту. Пише лише туди, де поясу ще немає:
 * вибір, який людина вже зберегла, браузер не перезаписує.
 */
export async function detectTimezone(d: D1Database, userId: string, input: unknown): Promise<string | null> {
  const timezone = canonicalTimezone(input);
  if (!timezone) return null;
  const res = await d
    .prepare("UPDATE users SET timezone = ? WHERE id = ? AND timezone IS NULL")
    .bind(timezone, userId)
    .run();
  return res.meta.changes === 1 ? timezone : null;
}

// --- Видимість для компаній ---------------------------------------------------

export type VisibilityResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "no_user" | "no_scoring_consent" };

/**
 * «Show me to companies». Увімкнення: згода visibility (v1) + подія + прапор
 * одним пакетом. Вимкнення: прапор 0 і подія відкликання в тому ж пакеті.
 * Після запису кажемо CRM (hooks.ts), щоб вона позначила картки воронки.
 * Без балу показувати нічого, тож без прийнятих умов (або старої згоди на бал) увімкнути
 * не можна (docs/legal/consents.md, розділ 2).
 */
export async function setVisibility(d: D1Database, userId: string, on: boolean): Promise<VisibilityResult> {
  const row = await d
    .prepare(
      `SELECT u.visible_to_companies AS flag, c.granted, c.text_version,
              (SELECT MAX(granted) FROM consents WHERE user_id = u.id AND kind IN ${SCORING_BASIS_SQL}) AS scoring
         FROM users u LEFT JOIN consents c ON c.user_id = u.id AND c.kind = ?2
        WHERE u.id = ?1`,
    )
    .bind(userId, VISIBILITY_CONSENT.kind)
    .first<{ flag: number; granted: number | null; text_version: string | null; scoring: number | null }>();
  if (!row) return { ok: false, reason: "no_user" };

  const consentOn = row.granted === 1;
  if (on) {
    if (row.flag === 1 && consentOn && row.text_version === VISIBILITY_CONSENT.version) return { ok: true, changed: false };
    if (row.scoring !== 1) return { ok: false, reason: "no_scoring_consent" };
    await d.batch([
      ...consentChange(d, userId, VISIBILITY_CONSENT.kind, true, VISIBILITY_CONSENT.version),
      d.prepare("UPDATE users SET visible_to_companies = 1 WHERE id = ?").bind(userId),
    ]);
  } else {
    if (row.flag === 0 && !consentOn) return { ok: true, changed: false };
    await d.batch([
      ...(consentOn
        ? consentChange(d, userId, VISIBILITY_CONSENT.kind, false, row.text_version ?? VISIBILITY_CONSENT.version)
        : []),
      d.prepare("UPDATE users SET visible_to_companies = 0 WHERE id = ?").bind(userId),
    ]);
  }
  await notifyCrmVisibility(userId, on);
  return { ok: true, changed: true };
}

// --- Спосіб контакту ----------------------------------------------------------

export type ContactResult =
  | { ok: true; changed: boolean; from: ContactMode }
  | { ok: false; reason: "no_user" | "invalid" };

/**
 * «Show my Telegram directly». direct пише згоду contact; повернення до approval
 * відкликає її тим самим пакетом. direct можна обрати й без ніка в Telegram
 * (власник 14.09: контакт видно за замовчуванням): тоді режим чекає, компанія бачить
 * «Request intro», як і раніше, а пошту без «так» людини не бачить ніколи
 * (contactModeOf у lib/crm/project.ts і план знайомства вимагають нік).
 */
export async function setContactMode(d: D1Database, userId: string, mode: unknown): Promise<ContactResult> {
  if (mode !== "approval" && mode !== "direct") return { ok: false, reason: "invalid" };
  const row = await d
    .prepare(
      `SELECT u.contact_mode, c.granted, c.text_version
         FROM users u LEFT JOIN consents c ON c.user_id = u.id AND c.kind = ?2
        WHERE u.id = ?1`,
    )
    .bind(userId, CONTACT_CONSENT.kind)
    .first<{ contact_mode: ContactMode; granted: number | null; text_version: string | null }>();
  if (!row) return { ok: false, reason: "no_user" };
  const from = row.contact_mode;
  const consentOn = row.granted === 1;

  if (mode === "direct") {
    if (from === "direct" && consentOn) return { ok: true, changed: false, from };
    await d.batch([
      ...consentChange(d, userId, CONTACT_CONSENT.kind, true, CONTACT_CONSENT.version),
      d.prepare("UPDATE users SET contact_mode = 'direct' WHERE id = ?").bind(userId),
    ]);
    return { ok: true, changed: true, from };
  }

  if (from === "approval" && !consentOn) return { ok: true, changed: false, from };
  await d.batch([
    ...(consentOn
      ? consentChange(d, userId, CONTACT_CONSENT.kind, false, row.text_version ?? CONTACT_CONSENT.version)
      : []),
    d.prepare("UPDATE users SET contact_mode = 'approval' WHERE id = ?").bind(userId),
  ]);
  return { ok: true, changed: true, from };
}

// --- Умови в кінці анкети -------------------------------------------------------

export type TermsResult = { visible: boolean; direct: boolean; accepted: boolean };

/**
 * Людина натиснула останню кнопку анкети під рядком «By continuing you agree to the Terms and
 * Privacy.» (власник 14.09, раунд 3: без галок). Одним пакетом:
 * - одна подія згоди: умови (TERMS_ACCEPTANCE) з їх версією; бал іде з умовами;
 * - налаштування за замовчуванням з умов: видимий для компаній і Telegram-нік напряму. Вони
 *   пишуться лише як стан (consents з версією умов, без окремих подій: їх запис це подія умов)
 *   і лише якщо людина ще не обирала їх сама в налаштуваннях. Вимкнути можна будь-коли там же.
 * Повторне натискання з тією самою версією умов нічого не пише.
 */
export async function acceptTerms(d: D1Database, userId: string): Promise<TermsResult> {
  const [current, before] = await Promise.all([consentState(d, userId, TERMS_ACCEPTANCE.kind), loadSettings(d, userId)]);
  const fresh = !(current?.granted && current.version === TERMS_ACCEPTANCE.version);
  const defaults = (kind: string, set: string) => [
    // Спершу прапор (поки рядка згоди ще немає), потім сам рядок.
    d
      .prepare(`UPDATE users SET ${set} WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM consents WHERE user_id = ?1 AND kind = ?2)`)
      .bind(userId, kind),
    d
      .prepare(
        `INSERT INTO consents (user_id, kind, granted, text_version, at) VALUES (?, ?, 1, ?, datetime('now'))
         ON CONFLICT(user_id, kind) DO NOTHING`,
      )
      .bind(userId, kind, TERMS_ACCEPTANCE.version),
  ];
  await d.batch([
    ...defaults(VISIBILITY_CONSENT.kind, "visible_to_companies = 1"),
    ...defaults(CONTACT_CONSENT.kind, "contact_mode = 'direct'"),
    ...(fresh ? consentChange(d, userId, TERMS_ACCEPTANCE.kind, true, TERMS_ACCEPTANCE.version) : []),
  ]);
  const settings = await loadSettings(d, userId);
  const visible = settings?.visible ?? false;
  if (visible && !before?.visible) await notifyCrmVisibility(userId, true);
  return { visible, direct: settings?.contactMode === "direct", accepted: fresh };
}

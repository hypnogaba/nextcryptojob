import { getSettings } from "@/lib/admin/settings";
import { audit } from "@/lib/audit";
import { appEnv, db } from "@/lib/db";
import { getMailer } from "@/lib/mail";
import { addEmailCodeEmail, loginCodeEmail } from "@/lib/mail/login-code";
import { hmacSha256Hex, hmacSha256Verify } from "./hash";
import {
  CODE_EMAIL_DAY_LIMITS,
  CODE_EMAIL_LIMITS,
  CODE_IP_LIMITS,
  VERIFY_EMAIL_LIMITS,
  clearRate,
  consume,
  pruneRateStatement,
  type Limits,
} from "./ratelimit";
import { createSession } from "./session";

/**
 * Вхід поштою: 6-значний код, живе 10 хвилин, 5 спроб (специфікація C-1).
 *
 * Сам код у базу не пишемо: лише HMAC-SHA256(SESSION_SECRET, email + ':' + code)
 * (docs/contracts.md, §9). Акаунт народжується при першому вдалому вході.
 * Відповіді однакові для будь-якої адреси: з них не видно, чи є акаунт.
 *
 * Той самий код додає пошту до профілю без неї (вхід через Telegram): тоді в
 * HMAC входить ще й id людини, що просила код (CodePurpose). Такий код не
 * відкриває сесію, а сесія іншої людини не прийме його для своєї пошти. Ліміти
 * ті самі й спільні з входом. users.email пишеться лише тут, після перевірки
 * коду (інваріант docs/contracts.md).
 */

/** Для чого код: вхід або «додати пошту» до профілю userId, де вже є сесія. */
export type CodePurpose = { kind: "sign_in" } | { kind: "add_email"; userId: string };

const SIGN_IN: CodePurpose = { kind: "sign_in" };

/**
 * Що підписує HMAC. Для входу рядок той самий, що й раніше (коди в дорозі не
 * ламаються). Для пошти до профілю з пробілами: у нормалізованій адресі
 * пробілів немає, тож такий рядок ніколи не збіжеться з рядком входу.
 */
function codeMaterial(email: string, code: string, purpose: CodePurpose): string {
  return purpose.kind === "sign_in" ? `${email}:${code}` : `add-email ${purpose.userId} ${email}:${code}`;
}

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
/** Коротший ключ HMAC не приймаємо: вхід поштою вимикається (fail closed). */
export const MIN_SECRET_LENGTH = 32;

export type RequestCodeResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: "invalid_email" | "email_unavailable" | "rate_limited" | "send_failed";
      retryAfterMinutes?: number;
    };

export type CodeFailure = {
  ok: false;
  reason:
    | "invalid_email"
    | "invalid_code"
    | "email_unavailable"
    | "rate_limited"
    | "expired"
    | "wrong_code"
    | "too_many_attempts";
  attemptsLeft?: number;
  retryAfterMinutes?: number;
};

export type VerifyCodeResult =
  | { ok: true; userId: string; created: boolean }
  | CodeFailure
  /** Код правильний, акаунта з цією поштою немає, а нові реєстрації закрито (/admin/settings). */
  | { ok: false; reason: "signups_closed" };

export type AddEmailResult =
  | { ok: true; email: string }
  | CodeFailure
  /**
   * Ця пошта вже належить іншому профілю: код довів, що пошта людини, тож можна запропонувати
   * злиття (lib/account/merge.ts). otherId = той профіль (null, якщо його вже немає).
   */
  | { ok: false; reason: "taken"; otherId: string | null }
  /** У профілю вже є пошта. */
  | { ok: false; reason: "has_email" }
  | { ok: false; reason: "no_user" };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Адреса в єдиному вигляді (без пробілів, нижній регістр) або null. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

// Найбільше кратне 10^6, що вміщається в uint32. Значення вище відкидаємо:
// інакше залишок від ділення давав би малим кодам трохи більший шанс.
const CODE_SPACE = 1_000_000;
const UNBIASED_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;

/** Рівномірно випадковий код 000000..999999 з криптографічного джерела. */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < UNBIASED_LIMIT) return String(buf[0] % CODE_SPACE).padStart(6, "0");
  }
}

function secret(): string | null {
  const value = appEnv().SESSION_SECRET;
  if (!value) {
    console.error("Email sign-in is off: not configured: SESSION_SECRET");
    return null;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    console.error(`Email sign-in is off: SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`);
    return null;
  }
  return value;
}

/**
 * Рахує спробу за кожним ключем по черзі й зупиняється на першій відмові:
 * заблокована IP не з'їдає ліміт чужої адреси.
 */
async function consumeAll(keys: [string, Limits][]): Promise<{ allowed: boolean; retryAfterMinutes: number }> {
  for (const [key, limits] of keys) {
    const verdict = await consume(key, limits);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true, retryAfterMinutes: 0 };
}

/**
 * Надсилає код на адресу. ip для ліміту беремо з cf-connecting-ip. purpose
 * «add_email» прив'язує код до людини з сесії і міняє текст листа.
 */
export async function requestCode(
  rawEmail: unknown,
  ip: string,
  purpose: CodePurpose = SIGN_IN,
): Promise<RequestCodeResult> {
  const mailer = getMailer(appEnv());
  const key = secret();
  if (!mailer || !key) return { ok: false, reason: "email_unavailable" };

  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_email" };

  // Ліміти рахуються ДО надсилання, одною інструкцією кожен (див. consume).
  const gate = await consumeAll([
    [`code:ip:${ip}`, CODE_IP_LIMITS],
    [`code:email:${email}`, CODE_EMAIL_LIMITS],
    [`code:email:day:${email}`, CODE_EMAIL_DAY_LIMITS],
  ]);
  if (!gate.allowed) {
    return { ok: false, reason: "rate_limited", retryAfterMinutes: gate.retryAfterMinutes };
  }

  const code = randomCode();
  const codeHash = await hmacSha256Hex(key, codeMaterial(email, code, purpose));
  const d = db();
  const [, , inserted] = await d.batch<{ id: number }>([
    d.prepare("DELETE FROM login_codes WHERE expires_at < datetime('now', '-1 day')"),
    pruneRateStatement(d),
    d
      .prepare(
        "INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', ?)) RETURNING id",
      )
      .bind(email, codeHash, `+${CODE_TTL_MINUTES} minutes`),
  ]);
  const newId = inserted.results[0]?.id;
  if (newId === undefined) throw new Error("login code insert returned no id");

  try {
    const letter = purpose.kind === "sign_in" ? loginCodeEmail : addEmailCodeEmail;
    await mailer.send({ to: email, ...letter(code, CODE_TTL_MINUTES) });
  } catch (err) {
    console.error("Login code email failed:", err instanceof Error ? err.message : String(err));
    // Лист не дійшов: новий код ніхто не знає, а попередній лишається дійсним.
    await d.prepare("DELETE FROM login_codes WHERE id = ?").bind(newId).run();
    return { ok: false, reason: "send_failed" };
  }

  // Лист пішов: попередні невикористані коди цієї адреси більше не діють.
  // Лише старші за новий, щоб паралельний запит не стер свіжіший код.
  await d
    .prepare("DELETE FROM login_codes WHERE email = ? AND used_at IS NULL AND id < ?")
    .bind(email, newId)
    .run();
  return { ok: true, email };
}

type CodeRow = { id: number; code_hash: string; attempts: number };

/**
 * Спільна частина перевірки: форма, ліміт, код з бази, спроба, HMAC і
 * одноразовість. { ok: true } означає, що код правильний і вже використаний.
 * Лічильник спроб стирає той, хто викликав, коли дія вдалася.
 */
async function spendCode(
  email: string,
  rawCode: unknown,
  purpose: CodePurpose,
): Promise<{ ok: true; limitKey: string } | CodeFailure> {
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid_code" };
  const key = secret();
  if (!key) return { ok: false, reason: "email_unavailable" };

  // Кожна перевірка рахується до порівняння; вдала дія лічильник стирає.
  const limitKey = `verify:email:${email}`;
  const gate = await consume(limitKey, VERIFY_EMAIL_LIMITS);
  if (!gate.allowed) {
    return { ok: false, reason: "rate_limited", retryAfterMinutes: gate.retryAfterMinutes };
  }

  const d = db();
  const row = await d
    .prepare(
      `SELECT id, code_hash, attempts FROM login_codes
        WHERE email = ? AND used_at IS NULL AND expires_at > datetime('now')
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(email)
    .first<CodeRow>();
  if (!row) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  // Спершу рахуємо спробу, потім порівнюємо: паралельні запити не
  // проскочать повз ліміт, бо умова attempts < 5 перевіряється в тому ж UPDATE.
  const counted = await d
    .prepare(
      `UPDATE login_codes SET attempts = attempts + 1
        WHERE id = ? AND used_at IS NULL AND attempts < ?
        RETURNING attempts`,
    )
    .bind(row.id, MAX_CODE_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!counted) return { ok: false, reason: "too_many_attempts" };

  if (!(await hmacSha256Verify(key, codeMaterial(email, code, purpose), row.code_hash))) {
    const attemptsLeft = MAX_CODE_ATTEMPTS - counted.attempts;
    return attemptsLeft > 0
      ? { ok: false, reason: "wrong_code", attemptsLeft }
      : { ok: false, reason: "too_many_attempts" };
  }

  // Код одноразовий: з двох одночасних входів тим самим кодом пройде один.
  const used = await d
    .prepare("UPDATE login_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL")
    .bind(row.id)
    .run();
  if (used.meta.changes !== 1) return { ok: false, reason: "expired" };
  return { ok: true, limitKey };
}

/**
 * Перевіряє код і, якщо він правильний, входить: знаходить або створює
 * людину, пише audit_log, відкриває сесію (кука). Лише в Server Action.
 *
 * Нові реєстрації закрито (signups_open = false): людина з акаунтом входить як
 * завжди, нової не створюємо. Про це кажемо лише після правильного коду: до нього
 * відповідь однакова для будь-якої адреси, тож не видно, чи є акаунт.
 */
export async function verifyCode(rawEmail: unknown, rawCode: unknown): Promise<VerifyCodeResult> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_email" };
  const spent = await spendCode(email, rawCode, SIGN_IN);
  if (!spent.ok) return spent;

  const d = db();
  const found = await findOrCreateUser(d, email, async () => (await getSettings(d)).signups_open);
  await clearRate(spent.limitKey);
  if (!found) {
    await audit(null, "auth.signup_closed", null, { method: "email" });
    return { ok: false, reason: "signups_closed" };
  }
  const { userId, created } = found;
  // Журнал до сесії: якщо запис упаде, людина не лишиться з кукою і
  // повідомленням про помилку водночас. Після createSession нічого не падає.
  await audit(userId, "auth.login_email", userId, { created });
  await createSession(userId, "email");
  return { ok: true, userId, created };
}

/**
 * «Add email»: перевіряє код, надісланий для цієї людини (requestCode з
 * purpose add_email), і лише тоді пише users.email. Сесію не чіпає: людина
 * лишається в сесії, якою ввійшла (метод входу не змінюється).
 */
export async function verifyAddEmailCode(userId: string, rawEmail: unknown, rawCode: unknown): Promise<AddEmailResult> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_email" };
  const spent = await spendCode(email, rawCode, { kind: "add_email", userId });
  if (!spent.ok) return spent;
  await clearRate(spent.limitKey);

  const result = await attachEmail(db(), userId, email);
  switch (result) {
    case "added":
      await audit(userId, "account.email_added", userId);
      return { ok: true, email };
    case "already":
      return { ok: true, email };
    case "taken": {
      await audit(userId, "account.email_conflict", userId);
      const other = await db()
        .prepare("SELECT id FROM users WHERE lower(email) = ? AND id <> ? LIMIT 1")
        .bind(email, userId)
        .first<{ id: string }>();
      return { ok: false, reason: "taken", otherId: other?.id ?? null };
    }
    default:
      return { ok: false, reason: result };
  }
}

/**
 * Одна інструкція і перевіряє, і пише: у профілю ще немає пошти, а адреса
 * (без огляду на регістр) нічия. Паралельний запис тієї ж адреси впреться в
 * UNIQUE, і це теж «taken».
 */
async function attachEmail(
  d: D1Database,
  userId: string,
  email: string,
): Promise<"added" | "already" | "taken" | "has_email" | "no_user"> {
  try {
    const res = await d
      .prepare(
        `UPDATE users SET email = ?2
          WHERE id = ?1 AND email IS NULL
            AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = ?2)`,
      )
      .bind(userId, email)
      .run();
    if (res.meta.changes === 1) return "added";
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return "taken";
    throw err;
  }
  const row = await d.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string | null }>();
  if (!row) return "no_user";
  if (row.email === null) return "taken";
  return row.email.toLowerCase() === email ? "already" : "has_email";
}

/**
 * Людина з цією поштою або нова. Шукаємо без огляду на регістр (старі рядки
 * могли лягти з великими літерами), нові пишемо лише в нижньому регістрі.
 * ON CONFLICT робить повтор і паралельний вхід безпечними. null: людини немає,
 * а canCreate каже «не створювати» (реєстрації закрито). canCreate питаємо лише
 * тоді, тож вхід того, хто вже є, налаштувань не читає.
 */
async function findOrCreateUser(
  d: D1Database,
  email: string,
  canCreate: () => Promise<boolean>,
): Promise<{ userId: string; created: boolean } | null> {
  const find = () =>
    d.prepare("SELECT id FROM users WHERE lower(email) = ? LIMIT 1").bind(email).first<{ id: string }>();

  const existing = await find();
  if (existing) return { userId: existing.id, created: false };
  if (!(await canCreate())) return null;

  const fresh = crypto.randomUUID();
  const inserted = await d
    .prepare("INSERT INTO users (id, email, channel) VALUES (?, ?, 'email') ON CONFLICT(email) DO NOTHING")
    .bind(fresh, email)
    .run();
  if (inserted.meta.changes === 1) return { userId: fresh, created: true };

  const raced = await find();
  if (!raced) throw new Error("user row missing after insert");
  return { userId: raced.id, created: false };
}

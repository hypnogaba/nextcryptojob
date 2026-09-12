import { audit } from "@/lib/audit";
import { appEnv, db } from "@/lib/db";
import { getMailer } from "@/lib/mail";
import { loginCodeEmail } from "@/lib/mail/login-code";
import { hmacSha256Hex, hmacSha256Verify } from "./hash";
import {
  CODE_EMAIL_LIMITS,
  CODE_IP_LIMITS,
  VERIFY_EMAIL_LIMITS,
  checkRate,
  clearRate,
  pruneRateStatement,
  recordAttempt,
} from "./ratelimit";
import { createSession } from "./session";

/**
 * Вхід поштою: 6-значний код, живе 10 хвилин, 5 спроб (специфікація C-1).
 *
 * Сам код у базу не пишемо: лише HMAC-SHA256(SESSION_SECRET, email + ':' + code)
 * (docs/contracts.md, §9). Акаунт народжується при першому вдалому вході.
 * Відповіді однакові для будь-якої адреси: з них не видно, чи є акаунт.
 */

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;

export type RequestCodeResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: "invalid_email" | "email_unavailable" | "rate_limited" | "send_failed";
      retryAfterMinutes?: number;
    };

export type VerifyCodeResult =
  | { ok: true; userId: string; created: boolean }
  | {
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
  return value;
}

/** Надсилає код на адресу. ip для ліміту беремо з cf-connecting-ip. */
export async function requestCode(rawEmail: unknown, ip: string): Promise<RequestCodeResult> {
  const mailer = getMailer(appEnv());
  const key = secret();
  if (!mailer || !key) return { ok: false, reason: "email_unavailable" };

  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_email" };

  const emailKey = `code:email:${email}`;
  const ipKey = `code:ip:${ip}`;
  const gate = await checkRate(emailKey, ipKey);
  if (!gate.allowed) {
    return { ok: false, reason: "rate_limited", retryAfterMinutes: gate.retryAfterMinutes };
  }
  await recordAttempt(emailKey, CODE_EMAIL_LIMITS);
  await recordAttempt(ipKey, CODE_IP_LIMITS);

  const code = randomCode();
  const codeHash = await hmacSha256Hex(key, `${email}:${code}`);
  const d = db();
  await d.batch([
    // Новий код скасовує всі попередні невикористані для цієї адреси.
    d.prepare("DELETE FROM login_codes WHERE email = ? AND used_at IS NULL").bind(email),
    d.prepare("DELETE FROM login_codes WHERE expires_at < datetime('now', '-1 day')"),
    pruneRateStatement(d),
    d
      .prepare("INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', ?))")
      .bind(email, codeHash, `+${CODE_TTL_MINUTES} minutes`),
  ]);

  try {
    await mailer.send({ to: email, ...loginCodeEmail(code, CODE_TTL_MINUTES) });
  } catch (err) {
    console.error("Login code email failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true, email };
}

type CodeRow = { id: number; code_hash: string; attempts: number };

/**
 * Перевіряє код і, якщо він правильний, входить: знаходить або створює
 * людину, відкриває сесію (кука), пише audit_log. Лише в Server Action.
 */
export async function verifyCode(rawEmail: unknown, rawCode: unknown): Promise<VerifyCodeResult> {
  const email = normaliseEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid_email" };
  const code = typeof rawCode === "string" ? rawCode.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid_code" };
  const key = secret();
  if (!key) return { ok: false, reason: "email_unavailable" };

  const limitKey = `verify:email:${email}`;
  const gate = await checkRate(limitKey);
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

  if (!(await hmacSha256Verify(key, `${email}:${code}`, row.code_hash))) {
    await recordAttempt(limitKey, VERIFY_EMAIL_LIMITS);
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

  const { userId, created } = await findOrCreateUser(d, email);
  await clearRate(limitKey);
  await createSession(userId);
  await audit(userId, "auth.login_email", userId, { created });
  return { ok: true, userId, created };
}

/** Людина з цією поштою або нова. Безпечно при повторі й паралельних входах. */
async function findOrCreateUser(
  d: D1Database,
  email: string,
): Promise<{ userId: string; created: boolean }> {
  const fresh = crypto.randomUUID();
  const inserted = await d
    .prepare("INSERT INTO users (id, email, channel) VALUES (?, ?, 'email') ON CONFLICT(email) DO NOTHING")
    .bind(fresh, email)
    .run();
  if (inserted.meta.changes === 1) return { userId: fresh, created: true };

  const existing = await d.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!existing) throw new Error("user row missing after insert");
  return { userId: existing.id, created: false };
}

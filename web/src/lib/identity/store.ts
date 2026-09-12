// Підключені джерела людини в D1 (таблиця identities, 0008_sources_v5).
// UNIQUE(kind, value): один нік чи адреса належить одному акаунту. Чужий запис
// ми не перезаписуємо, лише кажемо людині, що це джерело вже в іншому профілі.
import type { IdentityKind } from "./normalize";
import type { Wallet } from "./wallets";

export type Identity = {
  id: number;
  kind: IdentityKind;
  value: string;
  verifiedVia: string | null;
  verifiedAt: string | null;
  verifyCode: string | null;
};

/** Джерела, де в людини один запис: новий замінює старий. */
export type SingleKind = "x" | "github" | "youtube" | "site" | "sherlock";

/**
 * Ті, що сайт сам перевіряє кодом у біо. Неперевірену заявку іншого акаунта на
 * такий нік власник забирає кодом заявки (lib/verify/claim.ts). Гаманці так
 * не забираються: їх ще нічим підтвердити.
 */
export const VERIFIABLE: ReadonlySet<IdentityKind> = new Set(["x", "github"]);

type Row = {
  id: number;
  kind: IdentityKind;
  value: string;
  verified_via: string | null;
  verified_at: string | null;
  verify_code: string | null;
};

const toIdentity = (r: Row): Identity => ({
  id: r.id,
  kind: r.kind,
  value: r.value,
  verifiedVia: r.verified_via,
  verifiedAt: r.verified_at,
  verifyCode: r.verify_code,
});

export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err));
}

export async function listIdentities(db: D1Database, userId: string): Promise<Identity[]> {
  const { results } = await db
    .prepare(
      "SELECT id, kind, value, verified_via, verified_at, verify_code FROM identities WHERE user_id = ? ORDER BY id",
    )
    .bind(userId)
    .all<Row>();
  return results.map(toIdentity);
}

export async function getIdentity(db: D1Database, userId: string, kind: SingleKind): Promise<Identity | null> {
  const row = await db
    .prepare(
      "SELECT id, kind, value, verified_via, verified_at, verify_code FROM identities " +
        "WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(userId, kind)
    .first<Row>();
  return row ? toIdentity(row) : null;
}

export type SetResult =
  | { ok: true }
  /** Уже в іншому профілі (перевірене або таке, що не звільняється). */
  | { ok: false; reason: "taken" }
  /** Нік в іншого профілю без підтвердження: власник може забрати його кодом заявки. */
  | { ok: false; reason: "pending" };

/**
 * Ставить людині одне значення джерела (X, GitHub, YouTube, сайт, Sherlock),
 * прибираючи її попереднє. Своє те саме значення не чіпає: код у біо, який
 * людина вже поставила, лишається дійсним. `verifyCode` пишеться лише в новий
 * запис або в неперевірений без коду.
 */
export async function setSingleIdentity(
  db: D1Database,
  userId: string,
  kind: SingleKind,
  value: string,
  verifyCode: string | null = null,
): Promise<SetResult> {
  const existing = await db
    .prepare("SELECT user_id, verified_at, verify_code FROM identities WHERE kind = ? AND value = ?")
    .bind(kind, value)
    .first<{ user_id: string; verified_at: string | null; verify_code: string | null }>();

  // Чужий рядок не чіпаємо ніколи: давність нічого не доводить (його можна
  // прибрати й додати знову), доводить лише код заявки.
  if (existing && existing.user_id !== userId) {
    return { ok: false, reason: existing.verified_at || !VERIFIABLE.has(kind) ? "taken" : "pending" };
  }
  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db.prepare("DELETE FROM identities WHERE user_id = ? AND kind = ? AND value <> ?").bind(userId, kind, value),
  );
  if (existing && existing.user_id === userId) {
    if (!existing.verified_at && !existing.verify_code && verifyCode) {
      stmts.push(
        db
          .prepare("UPDATE identities SET verify_code = ? WHERE user_id = ? AND kind = ? AND value = ?")
          .bind(verifyCode, userId, kind, value),
      );
    }
  } else {
    stmts.push(
      db
        .prepare("INSERT INTO identities (user_id, kind, value, verify_code) VALUES (?, ?, ?, ?)")
        .bind(userId, kind, value, verifyCode),
    );
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "taken" };
    throw err;
  }
  return { ok: true };
}

export async function removeIdentities(db: D1Database, userId: string, kind: SingleKind): Promise<void> {
  await db.prepare("DELETE FROM identities WHERE user_id = ? AND kind = ?").bind(userId, kind).run();
}

/** Позначає своє неперевірене джерело перевіреним. false, якщо рядка вже немає. */
export async function markVerified(
  db: D1Database,
  userId: string,
  kind: SingleKind,
  value: string,
  via: "bio_code" | "post_code",
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE identities SET verified_via = ?, verified_at = datetime('now'), verify_code = NULL " +
        "WHERE user_id = ? AND kind = ? AND value = ? AND verified_at IS NULL",
    )
    .bind(via, userId, kind, value)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Передає нік людині перевіреним після коду заявки, одним пакетом: прибрати
 * неперевірений рядок іншого профілю, свій попередній рядок цього джерела й
 * вставити свій перевірений. Якщо той профіль тим часом підтвердив нік, його
 * рядок лишається, INSERT падає на UNIQUE, і пакет відкочується цілком.
 */
export async function takeOverIdentity(
  db: D1Database,
  userId: string,
  kind: SingleKind,
  value: string,
  via: "bio_code" | "post_code",
): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare("DELETE FROM identities WHERE kind = ? AND value = ? AND user_id <> ? AND verified_at IS NULL")
        .bind(kind, value, userId),
      db.prepare("DELETE FROM identities WHERE user_id = ? AND kind = ?").bind(userId, kind),
      db
        .prepare(
          "INSERT INTO identities (user_id, kind, value, verified_via, verified_at) VALUES (?, ?, ?, ?, datetime('now'))",
        )
        .bind(userId, kind, value, via),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  return true;
}

export type WalletsResult =
  | { ok: true; added: number; removed: number }
  | { ok: false; taken: Wallet[] };

/**
 * Замінює набір гаманців людини на новий. Адреса, що вже в іншому профілі,
 * повертається списком, і тоді не зберігаємо нічого: людина прибере її й
 * натисне ще раз. Наявні свої адреси лишаються як є.
 */
export async function setWallets(db: D1Database, userId: string, wallets: Wallet[]): Promise<WalletsResult> {
  if (wallets.length > 0) {
    // OR по парах (kind, value) іде індексом UNIQUE, без повного перегляду таблиці.
    const where = wallets.map(() => "(kind = ? AND value = ?)").join(" OR ");
    const { results } = await db
      .prepare(`SELECT kind, value FROM identities WHERE user_id <> ? AND (${where})`)
      .bind(userId, ...wallets.flatMap((w) => [w.kind, w.value]))
      .all<Wallet>();
    if (results.length > 0) return { ok: false, taken: results.map((r) => ({ kind: r.kind, value: r.value })) };
  }

  const { results: current } = await db
    .prepare("SELECT id, kind, value FROM identities WHERE user_id = ? AND kind IN ('evm', 'solana')")
    .bind(userId)
    .all<{ id: number; kind: string; value: string }>();
  const wanted = new Set(wallets.map((w) => `${w.kind}:${w.value}`));
  const have = new Set(current.map((c) => `${c.kind}:${c.value}`));
  const removeIds = current.filter((c) => !wanted.has(`${c.kind}:${c.value}`)).map((c) => c.id);
  const add = wallets.filter((w) => !have.has(`${w.kind}:${w.value}`));

  const stmts: D1PreparedStatement[] = [];
  if (removeIds.length > 0) {
    stmts.push(
      db
        .prepare(`DELETE FROM identities WHERE user_id = ? AND id IN (${removeIds.map(() => "?").join(", ")})`)
        .bind(userId, ...removeIds),
    );
  }
  for (const w of add) {
    stmts.push(db.prepare("INSERT INTO identities (user_id, kind, value) VALUES (?, ?, ?)").bind(userId, w.kind, w.value));
  }
  if (stmts.length === 0) return { ok: true, added: 0, removed: 0 };
  try {
    await db.batch(stmts);
  } catch (err) {
    // Хтось додав цю адресу між перевіркою й записом.
    if (isUniqueViolation(err)) return { ok: false, taken: [] };
    throw err;
  }
  return { ok: true, added: add.length, removed: removeIds.length };
}

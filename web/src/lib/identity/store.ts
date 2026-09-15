// Підключені джерела людини в D1 (таблиця identities, 0008_sources_v5, 0022).
// З 0022 (раунд 3 власника, 14.09) той самий нік чи адреса може бути в кількох профілях:
// UNIQUE(user_id, kind, value). Ми віримо тому, що людина вписала (модель довіри 13.09), і
// не питаємо коду в біо, навіть якщо хтось уже вписав той самий нік.
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

/**
 * Ставить людині одне значення джерела (X, GitHub, YouTube, сайт, Sherlock), прибираючи її
 * попереднє. Своє те саме значення не чіпає (дата додавання й давня позначка перевірки лишаються).
 * Той самий нік в іншому профілі не заважає (0022).
 */
export async function setSingleIdentity(db: D1Database, userId: string, kind: SingleKind, value: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM identities WHERE user_id = ? AND kind = ? AND value <> ?").bind(userId, kind, value),
    db
      .prepare("INSERT INTO identities (user_id, kind, value) VALUES (?, ?, ?) ON CONFLICT(user_id, kind, value) DO NOTHING")
      .bind(userId, kind, value),
  ]);
}

export async function removeIdentities(db: D1Database, userId: string, kind: SingleKind): Promise<void> {
  await db.prepare("DELETE FROM identities WHERE user_id = ? AND kind = ?").bind(userId, kind).run();
}

export type WalletsResult = { added: number; removed: number };

/**
 * Замінює набір гаманців людини на новий. Наявні свої адреси лишаються як є; адреса, яку вписав
 * і хтось інший, людині не заважає (0022).
 */
export async function setWallets(db: D1Database, userId: string, wallets: Wallet[]): Promise<WalletsResult> {
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
    stmts.push(
      db
        .prepare("INSERT INTO identities (user_id, kind, value) VALUES (?, ?, ?) ON CONFLICT(user_id, kind, value) DO NOTHING")
        .bind(userId, w.kind, w.value),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { added: add.length, removed: removeIds.length };
}

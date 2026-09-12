// Згоди людини (docs/contracts.md, §9): consents = поточний стан, consent_events =
// незмінна історія. Кожна зміна пише обидві таблиці в одній пакетній транзакції,
// щоб стан ніколи не розійшовся з історією.

export const SCORING_CONSENT = {
  kind: "scoring",
  version: "v1",
  text: "I agree that NextCryptoJob computes my score from the public data I connected.",
} as const;

/** Чи дала людина цю згоду (і не відкликала). */
export async function hasConsent(db: D1Database, userId: string, kind: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT granted FROM consents WHERE user_id = ? AND kind = ?")
    .bind(userId, kind)
    .first<{ granted: number }>();
  return row?.granted === 1;
}

/**
 * Дає згоду. Якщо та сама версія вже дана, нічого не пише: подія в історії
 * означає зміну, а не повторне натискання.
 */
export async function grantConsent(db: D1Database, userId: string, kind: string, version: string): Promise<boolean> {
  const current = await db
    .prepare("SELECT granted, text_version FROM consents WHERE user_id = ? AND kind = ?")
    .bind(userId, kind)
    .first<{ granted: number; text_version: string }>();
  if (current?.granted === 1 && current.text_version === version) return false;
  await db.batch([
    db
      .prepare(
        `INSERT INTO consents (user_id, kind, granted, text_version, at) VALUES (?, ?, 1, ?, datetime('now'))
         ON CONFLICT(user_id, kind) DO UPDATE SET granted = 1, text_version = excluded.text_version, at = excluded.at`,
      )
      .bind(userId, kind, version),
    db
      .prepare("INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES (?, ?, 1, ?)")
      .bind(userId, kind, version),
  ]);
  return true;
}

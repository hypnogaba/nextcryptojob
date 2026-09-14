// Згоди людини (docs/contracts.md, §9): consents = поточний стан, consent_events =
// незмінна історія. Кожна зміна пише обидві таблиці в одній пакетній транзакції,
// щоб стан ніколи не розійшовся з історією.

/**
 * Стара окрема згода на бал (галка до раунду 3 власника). Нових подій з нею не пишемо: бал
 * тепер частина послуги й іде з умовами (TERMS_ACCEPTANCE). Наявні рядки чинні далі.
 */
export const SCORING_CONSENT = {
  kind: "scoring",
  version: "v1",
  text: "I agree that NextCryptoJob computes my score from the public data I connected.",
} as const;

/**
 * Умови для кандидатів разом з політикою приватності (вона частина умов). Власник 14.09, раунд 3:
 * «підписувати 2 документи забагато, користування сервісом і є згодою». Галки немає: під останньою
 * кнопкою анкети рядок «By continuing you agree to the Terms and Privacy.», і натискання пише одну
 * подію з версією умов. Версія = версія docs/legal/terms-candidates.md.
 */
export const TERMS_ACCEPTANCE = {
  kind: "terms",
  version: "terms-0.2",
} as const;

/**
 * Згоди, з якими бал рахується: прийняті умови або стара згода на бал. Для SQL:
 * `kind IN ${SCORING_BASIS_SQL}`.
 */
export const SCORING_BASIS_SQL = `('${SCORING_CONSENT.kind}', '${TERMS_ACCEPTANCE.kind}')`;

/** «Show me to companies» у налаштуваннях (docs/legal/consents.md, розділ 2). */
export const VISIBILITY_CONSENT = {
  kind: "visibility",
  version: "v1",
  text:
    "Show me to companies with access: they can see my scores, roles, level, chains and verification badges, " +
    "but never my wallet addresses, email or handles.",
} as const;

/**
 * «Show my Telegram directly» у налаштуваннях (docs/legal/consents.md, розділ 3b). Без ніка
 * в Telegram режим чекає: компанія бачить «Request intro», пошту не бачить ніколи.
 */
export const CONTACT_CONSENT = {
  kind: "contact",
  version: "v1",
  text: "Show my Telegram handle to every company that can see my profile, without asking me first.",
} as const;

export type ConsentState = { granted: boolean; version: string };

/** Поточний стан згоди або null, якщо людина її ще не бачила. */
export async function consentState(db: D1Database, userId: string, kind: string): Promise<ConsentState | null> {
  const row = await db
    .prepare("SELECT granted, text_version FROM consents WHERE user_id = ? AND kind = ?")
    .bind(userId, kind)
    .first<{ granted: number; text_version: string }>();
  return row ? { granted: row.granted === 1, version: row.text_version } : null;
}

/**
 * Дві інструкції однієї зміни згоди: новий стан і подія в історії. Їх кладуть
 * у той самий DB.batch, що й решту зміни (наприклад прапор видимості), щоб
 * стан, історія й прапор не розійшлись.
 */
export function consentChange(
  db: D1Database,
  userId: string,
  kind: string,
  granted: boolean,
  version: string,
): D1PreparedStatement[] {
  const g = granted ? 1 : 0;
  return [
    db
      .prepare(
        `INSERT INTO consents (user_id, kind, granted, text_version, at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, kind) DO UPDATE SET granted = excluded.granted, text_version = excluded.text_version, at = excluded.at`,
      )
      .bind(userId, kind, g, version),
    db
      .prepare("INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES (?, ?, ?, ?)")
      .bind(userId, kind, g, version),
  ];
}

/** Чи є в людини підстава для балу: прийняті умови або стара згода на бал. */
export async function hasScoringBasis(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT MAX(granted) AS granted FROM consents WHERE user_id = ? AND kind IN ${SCORING_BASIS_SQL}`)
    .bind(userId)
    .first<{ granted: number | null }>();
  return row?.granted === 1;
}

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
  const current = await consentState(db, userId, kind);
  if (current?.granted && current.version === version) return false;
  await db.batch(consentChange(db, userId, kind, true, version));
  return true;
}

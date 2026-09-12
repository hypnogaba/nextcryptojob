/**
 * «Download my data» (GDPR ст. 15 і 20): усе, що ми знаємо про людину, одним
 * JSON. Колонки перелічені явно: нова колонка з секретом не потрапить у файл
 * сама собою. Не віддаємо id сесій (це хеш токена входу), хеші кодів входу й
 * verify_code (одноразовий код перевірки ніку).
 */

export const EXPORT_FORMAT = "nextcryptojob-export-v1";

const USER_COLUMNS = [
  "id", "email", "telegram_id", "telegram_username", "channel", "target_text", "roles",
  "remote_mode", "city", "salary_min", "salary_currency", "digest_hour", "timezone",
  "digest_paused", "visible_to_companies", "contact_mode", "onboarding_step",
  "created_at", "last_active_at",
] as const;

type Row = Record<string, unknown>;

/** JSON з бази як об'єкт; зіпсований або порожній лишаємо як є. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function all(d: D1Database, sql: string, userId: string): Promise<Row[]> {
  return (await d.prepare(sql).bind(userId).all<Row>()).results;
}

export type UserExport = {
  format: typeof EXPORT_FORMAT;
  exported_at: string;
  user: Row;
  identities: Row[];
  source_facts: Row[];
  scores: Row[];
  cards: Row[];
  consents: Row[];
  consent_events: Row[];
};

export async function exportUserData(d: D1Database, userId: string): Promise<UserExport | null> {
  const user = await d
    .prepare(`SELECT ${USER_COLUMNS.join(", ")} FROM users WHERE id = ?`)
    .bind(userId)
    .first<Row>();
  if (!user) return null;

  const [identities, sourceFacts, scores, cards, consents, consentEvents] = await Promise.all([
    all(d, "SELECT kind, value, verified_via, verified_at, created_at FROM identities WHERE user_id = ? ORDER BY id", userId),
    all(d, "SELECT source, facts_json, gap_reason, fetched_at FROM source_facts WHERE user_id = ? ORDER BY source", userId),
    all(
      d,
      "SELECT role, score, core, cover, breakdown_json, formula_version, computed_at FROM scores WHERE user_id = ? ORDER BY role",
      userId,
    ),
    all(
      d,
      "SELECT slug, role, score, level, display_name, formula_version, created_at, revoked_at FROM cards WHERE user_id = ? ORDER BY created_at",
      userId,
    ),
    all(d, "SELECT kind, granted, text_version, at FROM consents WHERE user_id = ? ORDER BY kind", userId),
    all(d, "SELECT kind, granted, text_version, at FROM consent_events WHERE user_id = ? ORDER BY id", userId),
  ]);

  return {
    format: EXPORT_FORMAT,
    exported_at: new Date().toISOString(),
    user: { ...user, roles: parsed(user.roles) },
    identities,
    source_facts: sourceFacts.map((r) => ({ ...r, facts_json: parsed(r.facts_json) })),
    scores: scores.map((r) => ({ ...r, breakdown_json: parsed(r.breakdown_json) })),
    cards,
    consents,
    consent_events: consentEvents,
  };
}

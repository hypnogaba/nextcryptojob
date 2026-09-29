/**
 * «Download my data» (GDPR ст. 15 і 20): усе, що ми знаємо про людину, одним
 * JSON. Колонки перелічені явно: нова колонка з секретом не потрапить у файл
 * сама собою. Не віддаємо id сесій (це хеш токена входу), хеші кодів входу й
 * verify_code (одноразовий код перевірки ніку), key_version профілю-доказу (від нього залежить ключ
 * відкриття), токен відповіді на знайомство (respond_token_hash), службові поля вебхуків і ключів компанії.
 */

export const EXPORT_FORMAT = "nextcryptojob-export-v1";

const USER_COLUMNS = [
  "id", "email", "telegram_id", "telegram_username", "channel", "target_text", "roles",
  "remote_mode", "city", "salary_min", "salary_currency", "digest_hour", "timezone",
  "digest_paused", "visible_to_companies", "contact_mode", "onboarding_step",
  "created_at", "last_active_at", "role_text", "card_public", "telegram_unreachable_at",
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
  profile_prefs: Row | null;
  saved_jobs: Row[];
  sent: Row[];
  digest_runs: Row[];
  /** 👍/👎 на вакансії з добірки (0028); company_key службовий, не виводимо. */
  job_feedback: Row[];
  /** Службові повідомлення воронки, які ми людині слали (0028). */
  nudges: Row[];
  intros: Row[];
  consents: Row[];
  consent_events: Row[];
};

export async function exportUserData(d: D1Database, userId: string): Promise<UserExport | null> {
  const user = await d
    .prepare(`SELECT ${USER_COLUMNS.join(", ")} FROM users WHERE id = ?`)
    .bind(userId)
    .first<Row>();
  if (!user) return null;

  const [identities, sourceFacts, scores, cards, prefs, savedJobs, sent, digestRuns, feedback, nudges, intros, consents, consentEvents] = await Promise.all([
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
    all(d, "SELECT hidden_json, links_json, show_wallet, updated_at FROM profile_prefs WHERE user_id = ?", userId),
    all(d, "SELECT job_ref, created_at FROM saved_jobs WHERE user_id = ? ORDER BY created_at, job_ref", userId),
    all(
      d,
      "SELECT job_ref, source, digest_id, position, status, channel, why, created_at, sent_at FROM sent WHERE user_id = ? ORDER BY id",
      userId,
    ),
    all(
      d,
      "SELECT id, local_date, status, jobs, channel, error, created_at, finished_at FROM digest_runs WHERE user_id = ? ORDER BY local_date",
      userId,
    ),
    all(d, "SELECT job_ref, vote, reason, at FROM job_feedback WHERE user_id = ? ORDER BY at, id", userId),
    all(d, "SELECT kind, channel, sent_at, answered_at FROM nudges WHERE user_id = ? ORDER BY sent_at, id", userId),
    // Знайомства, які компанії просили в цієї людини: те, що вона сама бачила й відповідала. Без токена відповіді.
    all(
      d,
      `SELECT i.id, c.name AS company, i.role, i.mode, i.status, i.message, i.hiring_for, i.requested_via, i.notify_channel,
              i.notified_at, i.expires_at, i.responded_at, i.candidate_blocked, i.contact_kind, i.contact_value, i.created_at
         FROM intros i JOIN companies c ON c.id = i.company_id WHERE i.user_id = ? ORDER BY i.created_at, i.id`,
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
    profile_prefs: prefs[0]
      ? {
          hidden: parsed(prefs[0].hidden_json),
          links: parsed(prefs[0].links_json),
          show_wallet: prefs[0].show_wallet,
          updated_at: prefs[0].updated_at,
        }
      : null,
    saved_jobs: savedJobs,
    sent,
    digest_runs: digestRuns,
    job_feedback: feedback,
    nudges,
    intros,
    consents,
    consent_events: consentEvents,
  };
}

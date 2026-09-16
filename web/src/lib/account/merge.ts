import { hmacSha256Hex, hmacSha256Verify } from "@/lib/auth/hash";
import { parseSavedStep, savedStepRank } from "@/lib/onboarding/steps";

/**
 * Злиття двох профілів однієї людини (власник 14.09, раунд 3: «моя пошта вже була додана, а
 * сайт просив додати її знову»). Людина ввійшла одним профілем (скажімо, Telegram), додає пошту,
 * а пошта належить іншому її профілю. Код з листа доводить, що обидва її, і тоді вона може злити їх.
 *
 * Хто лишається: профіль, яким людина зараз увійшла (survivor). Сесія не рветься, куку не міняємо;
 * сесії другого профілю переходять до нього ж, тож інший браузер теж лишається з входом. Другий
 * рядок users видаляється в кінці того самого пакета.
 *
 * Що переходить (одним DB.batch: або все, або нічого):
 * - users: пошта й telegram_id обидва на survivor; анкета (слова, ролі, місце, зарплата, канал і
 *   година добірки, видимість, контакт, досягнутий крок) з того профілю, що пройшов далі (winner),
 *   за рівності з survivor; created_at найраніший, last_active_at найпізніший;
 * - identities: гаманці всі (без повторів); X, GitHub, YouTube, сайт і Sherlock по одному на вид,
 *   winner переважає, чого в нього немає, береться з іншого;
 * - source_facts, scores, consents: по ключу (джерело, роль, вид згоди) winner переважає, решта
 *   доповнює; бал однаково перераховується після злиття з об'єднаних джерел;
 * - consent_events, score_jobs (крім черги: після злиття ставимо одне нове завдання), cards (з
 *   двох активних карток однієї ролі лишається картка winner, друга відкликається, рядок лишається);
 * - sent і digest_runs: історія добірок; той самий рядок у двох профілях (та сама вакансія, той
 *   самий день) лишається один, листи й вакансії дня переходять до рядка survivor;
 * - company_members (з двох членств в одній компанії лишається одне, роль owner переважає),
 *   pipeline і intros кандидата (дві картки в одній компанії зводяться в одну з усіма нотатками й
 *   історією, дві відкриті заявки однієї компанії: друга скасовується), усі посилання «хто зробив»
 *   (created_by, invited_by, added_by, actor, requested_by, reviewed_by, granted_by, …).
 * audit_log не переписуємо (незмінна історія); злиття пишеться туди ж рядком account.merge.
 */

/** Кожне посилання на users(id) у схемі й що з ним робить злиття (тест звіряє зі схемою). */
export const MERGE_REFS: Record<string, "merged" | "moved" | "deleted"> = {
  "identities.user_id": "merged",
  "source_facts.user_id": "merged",
  "scores.user_id": "merged",
  "consents.user_id": "merged",
  "consent_events.user_id": "moved",
  "score_jobs.user_id": "merged",
  "sessions.user_id": "moved",
  "cards.user_id": "merged",
  "sent.user_id": "merged",
  "digest_runs.user_id": "merged",
  "saved_jobs.user_id": "merged",
  "profile_prefs.user_id": "merged",
  "company_members.user_id": "merged",
  "company_members.invited_by": "moved",
  "companies.created_by": "moved",
  "company_jobs.created_by_user_id": "moved",
  "saved_searches.created_by_user_id": "moved",
  "pipeline.user_id": "merged",
  "pipeline.added_by_user_id": "moved",
  "pipeline_events.actor_user_id": "moved",
  "intros.user_id": "merged",
  "intros.requested_by_user_id": "moved",
  "agency_applications.applicant_user_id": "moved",
  "agency_applications.reviewed_by": "moved",
  "subscriptions.granted_by": "moved",
  "api_keys.created_by_user_id": "moved",
  "api_keys.revoked_by_user_id": "moved",
  "usage_events.member_user_id": "moved",
  "x402_payments.refunded_by": "moved",
  "app_settings.updated_by": "moved",
};

type UserRow = {
  id: string;
  email: string | null;
  telegram_id: string | null;
  telegram_username: string | null;
  onboarding_step: string | null;
  created_at: string;
  last_active_at: string;
};

export type MergeResult =
  | { ok: true; survivor: string; merged: string; profileFrom: "survivor" | "merged" }
  | { ok: false; reason: "same_user" | "no_user" | "conflict" };

/** Поля анкети й налаштувань, які беремо цілком з профілю, що пройшов далі. */
const PROFILE_COLUMNS = [
  "channel", "target_text", "roles", "role_text", "remote_mode", "city", "salary_min", "salary_currency",
  "digest_hour", "timezone", "digest_paused", "visible_to_companies", "contact_mode", "onboarding_step",
] as const;

const SINGLE_KINDS = "('x', 'github', 'youtube', 'site', 'sherlock')";
const WALLET_KINDS = "('evm', 'solana')";
const STAGE_RANK: Record<string, number> = { found: 0, intro_requested: 1, contact_shared: 2, interview: 3, hired: 4, declined: -1 };

type PipelineRow = {
  id: number;
  company_id: string;
  user_id: string;
  stage: string;
  declined_by: string | null;
  role: string | null;
  job_id: string | null;
  tags: string;
  note_count: number;
  stage_changed_at: string;
};

function tagsOf(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Зливає профіль `otherId` у `survivorId` (докладно вгорі файлу). Не зливає, якщо обидва мають
 * різні пошти чи різні Telegram: одне з двох загубилося б (conflict).
 */
export async function mergeAccounts(d: D1Database, survivorId: string, otherId: string): Promise<MergeResult> {
  if (survivorId === otherId) return { ok: false, reason: "same_user" };
  const { results: users } = await d
    .prepare(
      `SELECT id, email, telegram_id, telegram_username, onboarding_step, created_at, last_active_at
         FROM users WHERE id IN (?1, ?2)`,
    )
    .bind(survivorId, otherId)
    .all<UserRow>();
  const s = users.find((u) => u.id === survivorId);
  const o = users.find((u) => u.id === otherId);
  if (!s || !o) return { ok: false, reason: "no_user" };
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() !== b.toLowerCase();
  if (differs(s.email, o.email) || differs(s.telegram_id, o.telegram_id)) return { ok: false, reason: "conflict" };

  // Анкета й налаштування з того, хто пройшов далі; за рівності лишається survivor.
  const otherAhead = savedStepRank(parseSavedStep(o.onboarding_step)) > savedStepRank(parseSavedStep(s.onboarding_step));
  const W = otherAhead ? otherId : survivorId;
  const L = otherAhead ? survivorId : otherId;

  // Дві картки воронки однієї компанії: читаємо заздалегідь, бо теги й етап зводимо в коді.
  const { results: cards } = await d
    .prepare(
      `SELECT id, company_id, user_id, stage, declined_by, role, job_id, tags, note_count, stage_changed_at
         FROM pipeline WHERE user_id IN (?1, ?2)
          AND company_id IN (SELECT company_id FROM pipeline WHERE user_id = ?1)
          AND company_id IN (SELECT company_id FROM pipeline WHERE user_id = ?2)`,
    )
    .bind(survivorId, otherId)
    .all<PipelineRow>();

  const S = survivorId;
  const O = otherId;
  const q = (sql: string, ...params: (string | number | null)[]) => d.prepare(sql).bind(...params);
  const st: D1PreparedStatement[] = [];

  // --- Рядок users ---------------------------------------------------------------------------
  // Спершу звільняємо пошту й Telegram у другого (UNIQUE), потім пишемо їх survivor.
  st.push(q("UPDATE users SET email = NULL, telegram_id = NULL WHERE id = ?", O));
  const profile = PROFILE_COLUMNS.map((c) => `${c} = (SELECT w.${c} FROM users w WHERE w.id = ?3)`).join(", ");
  st.push(
    q(
      `UPDATE users SET
         email = COALESCE(email, ?2),
         telegram_id = COALESCE(telegram_id, ?4),
         telegram_username = COALESCE(telegram_username, ?5),
         ${profile},
         created_at = min(created_at, ?6),
         last_active_at = max(last_active_at, ?7)
       WHERE id = ?1`,
      S,
      o.email?.toLowerCase() ?? null,
      W,
      o.telegram_id,
      o.telegram_username,
      o.created_at,
      o.last_active_at,
    ),
  );

  // --- Джерела, факти, бали, згоди: winner переважає по ключу ----------------------------------
  // key: вираз з колонок таблиці `t` для рядка-кандидата і `k` для рядка survivor/winner.
  const preferWinner = (table: string, keyMatch: string, where = "1 = 1") => {
    if (W === S) {
      st.push(
        q(
          `UPDATE ${table} SET user_id = ?1 WHERE user_id = ?2 AND ${where}
             AND NOT EXISTS (SELECT 1 FROM ${table} k WHERE k.user_id = ?1 AND ${keyMatch})`,
          S,
          O,
        ),
      );
    } else {
      st.push(
        q(
          `DELETE FROM ${table} WHERE user_id = ?1 AND ${where}
             AND EXISTS (SELECT 1 FROM ${table} k WHERE k.user_id = ?2 AND ${keyMatch})`,
          S,
          O,
        ),
      );
      st.push(q(`UPDATE ${table} SET user_id = ?1 WHERE user_id = ?2 AND ${where}`, S, O));
    }
  };
  preferWinner("identities", `k.kind = identities.kind`, `kind IN ${SINGLE_KINDS}`);
  // Гаманці всі; та сама адреса в обох лишається одна (решту прибере каскад з рядком users).
  st.push(q(`UPDATE OR IGNORE identities SET user_id = ?1 WHERE user_id = ?2 AND kind IN ${WALLET_KINDS}`, S, O));
  preferWinner("source_facts", `k.source = source_facts.source`);
  preferWinner("scores", `k.role = scores.role`);
  preferWinner("consents", `k.kind = consents.kind`);
  st.push(q("UPDATE consent_events SET user_id = ?1 WHERE user_id = ?2", S, O));

  // Черга: завдання другого профілю в черзі прибираємо, після злиття ставимо одне нове.
  st.push(q("DELETE FROM score_jobs WHERE user_id = ?1 AND status = 'queued'", O));
  st.push(q("UPDATE score_jobs SET user_id = ?1 WHERE user_id = ?2", S, O));

  // Картки: ОДНА картка на людину (раунд 5, п.7), не на людину й роль. Winner уже має активну
  // картку (будь-якої ролі): картка loser відкликається (рядок лишається, без redirect_to: той
  // самий власник, а не консолідація на /c/…). Інакше картка loser лишається єдиною далі.
  st.push(
    q(
      `UPDATE cards SET revoked_at = datetime('now')
        WHERE user_id = ?2 AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM cards w WHERE w.user_id = ?1 AND w.revoked_at IS NULL)`,
      W,
      L,
    ),
  );
  st.push(q("UPDATE cards SET user_id = ?1 WHERE user_id = ?2", S, O));

  // Сесії другого профілю тепер відкривають survivor.
  st.push(q("UPDATE sessions SET user_id = ?1 WHERE user_id = ?2", S, O));

  // --- Добірки -------------------------------------------------------------------------------
  // Той самий день в обох: вакансії дня переходять до рядка survivor, лічильник додається.
  st.push(
    q(
      `UPDATE digest_runs SET jobs = jobs + COALESCE((SELECT o.jobs FROM digest_runs o
             WHERE o.user_id = ?2 AND o.local_date = digest_runs.local_date), 0)
        WHERE user_id = ?1 AND local_date IN (SELECT local_date FROM digest_runs WHERE user_id = ?2)`,
      S,
      O,
    ),
  );
  st.push(
    q(
      `UPDATE sent SET digest_id = (SELECT s.id FROM digest_runs s JOIN digest_runs o ON o.local_date = s.local_date
                                     WHERE s.user_id = ?1 AND o.id = sent.digest_id)
        WHERE user_id = ?2 AND digest_id IN (SELECT o.id FROM digest_runs o JOIN digest_runs s ON s.local_date = o.local_date
                                              WHERE o.user_id = ?2 AND s.user_id = ?1)`,
      S,
      O,
    ),
  );
  st.push(q("UPDATE OR IGNORE digest_runs SET user_id = ?1 WHERE user_id = ?2", S, O));
  // Та сама вакансія в обох історіях лишається однією (рядок survivor).
  st.push(q("UPDATE OR IGNORE sent SET user_id = ?1 WHERE user_id = ?2", S, O));
  // Раунд 5, п.16: збережені вакансії обох профілів; та сама вже збережена в обох лишається одна.
  st.push(q("UPDATE OR IGNORE saved_jobs SET user_id = ?1 WHERE user_id = ?2", S, O));
  // Профіль-доказ: налаштування survivor лишаються; якщо своїх немає, беруться налаштування другого
  // профілю (його ключ виводився з іншого id, тож старе посилання подачі стає публічним).
  st.push(q("UPDATE OR IGNORE profile_prefs SET user_id = ?1 WHERE user_id = ?2", S, O));

  // --- Команди компаній ------------------------------------------------------------------------
  st.push(
    q(
      `UPDATE company_members SET role = 'owner'
        WHERE user_id = ?1 AND role <> 'owner'
          AND company_id IN (SELECT company_id FROM company_members WHERE user_id = ?2 AND role = 'owner')`,
      S,
      O,
    ),
  );
  st.push(q("UPDATE OR IGNORE company_members SET user_id = ?1 WHERE user_id = ?2", S, O));

  // --- Воронка й знайомства, де людина кандидат ----------------------------------------------
  const byCompany = new Map<string, { s?: PipelineRow; o?: PipelineRow }>();
  for (const c of cards) {
    const e = byCompany.get(c.company_id) ?? {};
    if (c.user_id === S) e.s = c;
    else e.o = c;
    byCompany.set(c.company_id, e);
  }
  for (const { s: keep, o: drop } of byCompany.values()) {
    if (!keep || !drop) continue;
    const tags = [...new Set([...tagsOf(keep.tags), ...tagsOf(drop.tags)])].slice(0, 10);
    // Етап: далі з двох; «declined» лише якщо відмовились в обох.
    const later = (STAGE_RANK[drop.stage] ?? 0) > (STAGE_RANK[keep.stage] ?? 0) ? drop : keep;
    st.push(q("UPDATE pipeline_events SET pipeline_id = ?1 WHERE pipeline_id = ?2", keep.id, drop.id));
    st.push(q("UPDATE intros SET pipeline_id = ?1 WHERE pipeline_id = ?2", keep.id, drop.id));
    st.push(
      q(
        `UPDATE pipeline SET note_count = note_count + ?2, tags = ?3, stage = ?4, declined_by = ?5,
                stage_changed_at = ?6, role = COALESCE(role, ?7), job_id = COALESCE(job_id, ?8), updated_at = datetime('now')
          WHERE id = ?1`,
        keep.id,
        drop.note_count,
        JSON.stringify(tags),
        later.stage,
        later.declined_by,
        later.stage_changed_at,
        drop.role,
        drop.job_id,
      ),
    );
    st.push(q("DELETE FROM pipeline WHERE id = ?", drop.id));
  }
  st.push(q("UPDATE pipeline SET user_id = ?1 WHERE user_id = ?2", S, O));
  // Дві відкриті заявки однієї компанії не можуть бути разом: заявку другого профілю скасовуємо.
  st.push(
    q(
      `UPDATE intros SET status = 'canceled', respond_token_hash = NULL, updated_at = datetime('now')
        WHERE user_id = ?2 AND status = 'pending'
          AND company_id IN (SELECT company_id FROM intros WHERE user_id = ?1 AND status = 'pending')`,
      S,
      O,
    ),
  );
  st.push(q("UPDATE intros SET user_id = ?1 WHERE user_id = ?2", S, O));

  // --- Хто що зробив (посилання з ON DELETE SET NULL) ----------------------------------------
  for (const [ref, how] of Object.entries(MERGE_REFS)) {
    if (how !== "moved" || ref === "consent_events.user_id" || ref === "sessions.user_id") continue;
    const [table, column] = ref.split(".");
    st.push(q(`UPDATE ${table} SET ${column} = ?1 WHERE ${column} = ?2`, S, O));
  }

  // --- Кінець: журнал і сам рядок ------------------------------------------------------------
  st.push(
    q(
      "INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?1, 'account.merge', ?1, ?2)",
      S,
      JSON.stringify({ merged: O, profile_from: W === S ? "survivor" : "merged" }),
    ),
  );
  // Каскад прибирає лише те, що лишилось повтором (та сама адреса, та сама вакансія, те саме членство).
  st.push(q("DELETE FROM users WHERE id = ?", O));

  await d.batch(st);
  return { ok: true, survivor: S, merged: O, profileFrom: W === S ? "survivor" : "merged" };
}

// ---------------------------------------------------------------------------------------------
// Дозвіл на злиття після коду з листа

/** Скільки живе дозвіл після правильного коду: людина читає, що станеться, і тисне кнопку. */
export const MERGE_GRANT_MINUTES = 15;

function grantMaterial(survivorId: string, otherId: string, email: string, exp: number): string {
  return `merge ${survivorId} ${otherId} ${email} ${exp}`;
}

/**
 * Дозвіл на злиття: видаємо лише після правильного коду з листа на пошту другого профілю
 * (lib/auth/email-code.ts). HMAC від SESSION_SECRET, id обох профілів, пошти й строку; у базі
 * нічого не зберігаємо. Без нього кнопка «Merge» нічого не робить.
 */
export async function mergeGrant(
  secret: string,
  survivorId: string,
  otherId: string,
  email: string,
  nowMs = Date.now(),
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + MERGE_GRANT_MINUTES * 60;
  return `${exp}.${await hmacSha256Hex(secret, grantMaterial(survivorId, otherId, email, exp))}`;
}

/** Чи дійсний дозвіл для цієї пари профілів і пошти зараз. */
export async function checkMergeGrant(
  secret: string,
  grant: unknown,
  survivorId: string,
  otherId: string,
  email: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (typeof grant !== "string") return false;
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(grant);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < nowMs) return false;
  return hmacSha256Verify(secret, grantMaterial(survivorId, otherId, email, exp), m[2]);
}

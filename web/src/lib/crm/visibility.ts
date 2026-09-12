/**
 * Правило видимості кандидата (специфікація CRM, 3.4): один SQL-фрагмент на
 * всі запити, перевірка наживо в кожному запиті, без кеша профілів.
 *
 * Людина видима, лише коли водночас:
 * - `users.visible_to_companies = 1`;
 * - є чинна згода `visibility`. У 0002 згода це поточний стан рядка
 *   `consents(user_id, kind, granted, …)`: чинна = `granted = 1` (колонки
 *   `revoked_at`, як у специфікації 3.4, у міграції немає);
 * - людина обрала хоч одну відому роль (contracts §1): без ролі анонімний профіль
 *   порожній, а зіпсований JSON ролей не зупиняє запит (CASE перед json_each).
 * Для запитів компанії ще:
 * - кандидат не заблокував компанію («Decline and block»: intros.candidate_blocked = 1).
 *   Блок виглядає як невидимість, без підказки, що саме блок;
 * - кандидат не член команди цієї компанії (не бачить себе в пошуку своєї компанії).
 *
 * Фрагменти мають позиційні `?`; параметри повертаються в тому ж порядку.
 */

import { ROLES } from "@/lib/card/roles";
import { appEnv, db as requestDb } from "@/lib/db";
import { getMailer, type Mailer } from "@/lib/mail";
import { sqlTime } from "@/lib/time";
import { systemAuditActor } from "./audit";
import { candidateLabel } from "./project";

export interface SqlFragment {
  sql: string;
  params: (string | number | null)[];
}

// Ключі ролей це константи [a-z_], тож їх можна вписати в SQL літералами.
const KNOWN_ROLES = Object.keys(ROLES)
  .map((k) => {
    if (!/^[a-z_]+$/.test(k)) throw new Error(`unexpected role key ${k}`);
    return `'${k}'`;
  })
  .join(", ");

/** Базова видимість (гість x402 і будь-яка компанія). `u` = псевдонім таблиці users. */
export function visibleSql(u = "u"): SqlFragment {
  return {
    sql: `${u}.visible_to_companies = 1
      AND EXISTS (SELECT 1 FROM consents vc
                   WHERE vc.user_id = ${u}.id AND vc.kind = 'visibility' AND vc.granted = 1)
      AND CASE WHEN json_valid(${u}.roles)
               THEN EXISTS (SELECT 1 FROM json_each(${u}.roles) vr WHERE vr.value IN (${KNOWN_ROLES}))
               ELSE 0 END`,
    params: [],
  };
}

/** Видимість для конкретної компанії (або базова, якщо компанії немає). */
export function visibleToSql(companyId: string | null, u = "u"): SqlFragment {
  const base = visibleSql(u);
  if (!companyId) return base;
  return {
    sql: `${base.sql}
      AND NOT EXISTS (SELECT 1 FROM intros vb
                       WHERE vb.company_id = ? AND vb.user_id = ${u}.id AND vb.candidate_blocked = 1)
      AND NOT EXISTS (SELECT 1 FROM company_members vm
                       WHERE vm.company_id = ? AND vm.user_id = ${u}.id)`,
    params: [companyId, companyId],
  };
}

/**
 * Бал показуємо лише для версії формули, що пройшла ворота якості (spec §6.3).
 * `s` = псевдонім таблиці scores. Інакше роль непорахована з причиною not_published.
 */
export function publishedSql(s = "s"): string {
  return `(${s}.score IS NOT NULL
      AND EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = ${s}.formula_version AND q.passed = 1))`;
}

/** Чи кандидат видимий для компанії (або для гостя, якщо companyId = null). */
export async function isVisibleTo(db: D1Database, userId: string, companyId: string | null): Promise<boolean> {
  const v = visibleToSql(companyId);
  const row = await db
    .prepare(`SELECT 1 AS ok FROM users u WHERE u.id = ? AND ${v.sql}`)
    .bind(userId, ...v.params)
    .first<{ ok: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// Хуки для налаштувань кандидата (специфікація CRM, 11 і 13)

/**
 * Після зміни видимості (уже записаної в базу). Видимість перевіряється
 * наживо в кожному запиті, тож пошук і профіль уже знають про зміну; хук
 * лише пише в історію кожної картки цієї людини `visibility_lost` (сховалась)
 * або `visibility_restored` (знову видима), рядок журналу компанії й новий
 * updated_at картки. Повторний виклик з тим самим станом нічого не пише
 * (дивимось останню подію видимості картки). Нотатки, теги, історія й уже
 * відкритий контакт лишаються; відкрите знайомство теж (кандидат може відповісти).
 */
export async function onVisibilityChanged(
  userId: string,
  visible: boolean,
  database: D1Database = requestDb(),
  now: Date = new Date(),
): Promise<{ cards: number }> {
  const kind = visible ? "visibility_restored" : "visibility_lost";
  const action = visible ? "pipeline.visibility_restored" : "pipeline.visibility_lost";
  const at = sqlTime(now);
  // Картки, чия остання подія видимості не така сама (без подій = була видима).
  const pending = `p.user_id = ?
    AND COALESCE((SELECT e.kind FROM pipeline_events e
                   WHERE e.pipeline_id = p.id AND e.kind IN ('visibility_lost', 'visibility_restored')
                   ORDER BY e.id DESC LIMIT 1), 'visibility_restored') <> ?`;
  // Порядок: журнал і updated_at, поки умова ще бачить старий стан; подія останньою.
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target, meta_json, at)
         SELECT p.company_id || ':system', ?, p.user_id,
                json_object('company_id', p.company_id, 'source', 'candidate_settings'), ?
           FROM pipeline p WHERE ${pending}`,
      )
      .bind(action, at, userId, kind),
    database.prepare(`UPDATE pipeline AS p SET updated_at = ? WHERE ${pending}`).bind(at, userId, kind),
    database
      .prepare(
        `INSERT INTO pipeline_events (pipeline_id, company_id, kind, actor_kind, created_at)
         SELECT p.id, p.company_id, ?, 'system', ? FROM pipeline p WHERE ${pending}`,
      )
      .bind(kind, at, userId, kind),
  ]);
  return { cards: results[2].meta.changes ?? 0 };
}

export const ERASED_SUBJECT = "A candidate you were in contact with deleted their account";

function erasedText(label: string): string {
  return (
    `A candidate you were in contact with (${label}) deleted their account. ` +
    "Please delete any copy of their contact details you keep outside NextCryptoJob."
  );
}

export interface ErasureResult {
  /** Компанії з карткою чи знайомством цієї людини (рядок журналу candidate.erased кожній). */
  companies: number;
  /** З них ті, кому людина відкрила контакт (їм лист власникам, GDPR ст. 19). */
  contactShared: number;
  /** Скільки листів пішло і скільки не вдалося. */
  mailed: number;
  mailFailed: number;
}

/**
 * Перед DELETE рядка users (специфікація 11). Одним пакетом:
 * - рядок журналу `candidate.erased` для кожної компанії з карткою або
 *   знайомством цієї людини (`meta.contact_shared` каже, чи був відкритий контакт);
 * - відкриті знайомства → `canceled` (відповісти на них уже нікому).
 * Потім лист власникам компаній, яким контакт відкрито. Лист не зупиняє
 * видалення: право на видалення важливіше, а обов'язок записано в журнал.
 * Самі картки, історію й знайомства видаляє каскад DELETE users після хука:
 * нотатки компанії не лишаються (5.4, 11).
 * Помилка бази кидається далі: краще не видалити, ніж видалити мовчки.
 */
export async function beforeCandidateErased(
  userId: string,
  opts: { db?: D1Database; mailer?: Mailer | null; now?: Date } = {},
): Promise<ErasureResult> {
  const database = opts.db ?? requestDb();
  const at = sqlTime(opts.now ?? new Date());

  const companies = await database
    .prepare(
      `SELECT c.id AS company_id,
              EXISTS (SELECT 1 FROM intros i WHERE i.company_id = c.id AND i.user_id = ?
                        AND i.status IN ('accepted', 'direct') AND i.contact_value IS NOT NULL) AS contact_shared,
              EXISTS (SELECT 1 FROM intros i WHERE i.company_id = c.id AND i.user_id = ? AND i.status = 'pending')
                AS intro_open
         FROM companies c
        WHERE c.id IN (SELECT company_id FROM pipeline WHERE user_id = ?
                       UNION SELECT company_id FROM intros WHERE user_id = ?)
        ORDER BY c.id`,
    )
    .bind(userId, userId, userId, userId)
    .all<{ company_id: string; contact_shared: number; intro_open: number }>();
  const rows = companies.results;
  const shared = rows.filter((r) => r.contact_shared === 1).map((r) => r.company_id);

  const writes: D1PreparedStatement[] = rows.map((r) =>
    database
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, 'candidate.erased', ?, ?, ?)")
      .bind(
        systemAuditActor(r.company_id),
        userId,
        JSON.stringify({ company_id: r.company_id, contact_shared: r.contact_shared === 1, intro_canceled: r.intro_open === 1 }),
        at,
      ),
  );
  writes.push(
    database
      .prepare(
        `UPDATE intros SET status = 'canceled', respond_token_hash = NULL, updated_at = ?
          WHERE user_id = ? AND status = 'pending'`,
      )
      .bind(at, userId),
  );
  await database.batch(writes);

  let mailed = 0;
  let mailFailed = 0;
  if (shared.length) {
    const owners = await database
      .prepare(
        `SELECT DISTINCT u.email FROM company_members m JOIN users u ON u.id = m.user_id
          WHERE m.role = 'owner' AND m.company_id IN (SELECT value FROM json_each(?))
            AND u.id <> ? AND u.email IS NOT NULL AND trim(u.email) <> ''`,
      )
      .bind(JSON.stringify(shared), userId)
      .all<{ email: string }>();
    const mailer = opts.mailer !== undefined ? opts.mailer : getMailer(appEnv());
    const text = erasedText(candidateLabel(userId));
    for (const { email } of owners.results) {
      if (!mailer) {
        mailFailed++;
        continue;
      }
      try {
        await mailer.send({ to: email, subject: ERASED_SUBJECT, text, html: `<p>${text}</p>` });
        mailed++;
      } catch (error) {
        mailFailed++;
        console.error("crm: erasure notice was not sent", error instanceof Error ? error.message : error);
      }
    }
    if (!mailer && mailFailed) console.error("crm: erasure notices not sent: not configured: EMAIL");
  }
  return { companies: rows.length, contactShared: shared.length, mailed, mailFailed };
}

export const LAST_OWNER_TEXT = "Make someone else an owner or close the company first.";

/**
 * Причина, чому акаунт видаляти не можна, або null (специфікація 6.3, 13):
 * людина єдиний власник компанії, яка ще не закрита.
 */
export async function erasureBlockReason(userId: string, database: D1Database = requestDb()): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT 1 AS blocked FROM company_members m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = ? AND m.role = 'owner' AND c.status <> 'closed'
          AND NOT EXISTS (SELECT 1 FROM company_members o
                           WHERE o.company_id = m.company_id AND o.role = 'owner'
                             AND o.user_id IS NOT NULL AND o.user_id <> m.user_id)
        LIMIT 1`,
    )
    .bind(userId)
    .first<{ blocked: number }>();
  return row ? LAST_OWNER_TEXT : null;
}

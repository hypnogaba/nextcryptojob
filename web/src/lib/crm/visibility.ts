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

/** Прапор, згода, роль: спільне для гостя й компанії, без правила демо. */
function consentedSql(u: string): string {
  return `${u}.visible_to_companies = 1
      AND EXISTS (SELECT 1 FROM consents vc
                   WHERE vc.user_id = ${u}.id AND vc.kind = 'visibility' AND vc.granted = 1)
      AND CASE WHEN json_valid(${u}.roles)
               THEN EXISTS (SELECT 1 FROM json_each(${u}.roles) vr WHERE vr.value IN (${KNOWN_ROLES}))
               ELSE 0 END`;
}

/**
 * Базова видимість (гість x402, будь-хто без компанії). `u` = псевдонім таблиці users.
 * Демо-кандидатів (users.is_demo, 0021) гість не бачить ніколи.
 */
export function visibleSql(u = "u"): SqlFragment {
  return { sql: `${consentedSql(u)}\n      AND ${u}.is_demo = 0`, params: [] };
}

/** Видимість для конкретної компанії (або базова, якщо компанії немає). */
export function visibleToSql(companyId: string | null, u = "u"): SqlFragment {
  if (!companyId) return visibleSql(u);
  return { sql: visibleToCompanyExpr("?", u), params: [companyId, companyId, companyId] };
}

/**
 * Те саме правило, де компанія це SQL-вираз (напр. колонка `p.company_id`), а
 * не параметр: так один запит перевіряє видимість кожної картки для її компанії.
 * `company` вставляється в SQL як є, тож лише вирази з коду, ніколи ввід.
 *
 * Демо-світ замкнений (0021): демо-кандидата бачить лише демо-компанія, а демо-компанія
 * бачить лише демо-кандидатів. Реальна компанія демо не побачить, а запит на знайомство
 * з демо-компанії ніколи не дійде до живої людини.
 */
export function visibleToCompanyExpr(company: string, u = "u"): string {
  return `${consentedSql(u)}
      AND ${u}.is_demo = COALESCE((SELECT vd.is_demo FROM companies vd WHERE vd.id = ${company}), 0)
      AND NOT EXISTS (SELECT 1 FROM intros vb
                       WHERE vb.company_id = ${company} AND vb.user_id = ${u}.id AND vb.candidate_blocked = 1)
      AND NOT EXISTS (SELECT 1 FROM company_members vm
                       WHERE vm.company_id = ${company} AND vm.user_id = ${u}.id)`;
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
 * Подія видимості, якої бракує картці `p`: жива видимість кандидата для
 * компанії картки (прапор, згода, роль, блок компанії, членство) проти
 * останньої події видимості картки (без подій = картку додали видимою).
 * NULL, коли вони збігаються.
 */
const MISSING_VISIBILITY_EVENT = `NULLIF(
  (SELECT CASE WHEN ${visibleToCompanyExpr("p.company_id")} THEN 'visibility_restored' ELSE 'visibility_lost' END
     FROM users u WHERE u.id = p.user_id),
  COALESCE((SELECT e.kind FROM pipeline_events e
             WHERE e.pipeline_id = p.id AND e.kind IN ('visibility_lost', 'visibility_restored')
             ORDER BY e.id DESC LIMIT 1), 'visibility_restored'))`;

/**
 * Інструкції, що зводять історію карток людини з живою видимістю: кожна
 * картка, чия видимість для її компанії змінилась, отримує `visibility_lost`
 * або `visibility_restored`, рядок журналу компанії й новий updated_at. Для
 * пакета викликача (T5: «Decline and block» разом з відповіддю на знайомство).
 * Порядок: журнал і updated_at, поки остання подія ще стара; подія останньою.
 */
export function visibilitySyncStatements(database: D1Database, userId: string, now: Date = new Date()): D1PreparedStatement[] {
  const at = sqlTime(now);
  return [
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target, meta_json, at)
         SELECT m.company_id || ':system', 'pipeline.' || m.kind, m.user_id,
                json_object('company_id', m.company_id, 'source', 'candidate'), ?
           FROM (SELECT p.company_id, p.user_id, ${MISSING_VISIBILITY_EVENT} AS kind FROM pipeline p WHERE p.user_id = ?) m
          WHERE m.kind IS NOT NULL`,
      )
      .bind(at, userId),
    database
      .prepare(`UPDATE pipeline AS p SET updated_at = ? WHERE p.user_id = ? AND ${MISSING_VISIBILITY_EVENT} IS NOT NULL`)
      .bind(at, userId),
    database
      .prepare(
        `INSERT INTO pipeline_events (pipeline_id, company_id, kind, actor_kind, created_at)
         SELECT m.id, m.company_id, m.kind, 'system', ?
           FROM (SELECT p.id, p.company_id, ${MISSING_VISIBILITY_EVENT} AS kind FROM pipeline p WHERE p.user_id = ?) m
          WHERE m.kind IS NOT NULL`,
      )
      .bind(at, userId),
  ];
}

/**
 * Звести історію карток людини з живою видимістю (visibilitySyncStatements)
 * окремим пакетом. Повторний виклик без змін нічого не пише.
 */
export async function syncVisibilityEvents(
  userId: string,
  database: D1Database = requestDb(),
  now: Date = new Date(),
): Promise<{ cards: number }> {
  const results = await database.batch(visibilitySyncStatements(database, userId, now));
  return { cards: results[2].meta.changes ?? 0 };
}

/**
 * Після зміни видимості в налаштуваннях (уже записаної в базу). Видимість
 * перевіряється наживо в кожному запиті, тож пошук і профіль уже знають про
 * зміну; хук пише в історію карток `visibility_lost` / `visibility_restored`
 * (syncVisibilityEvents). `visible` лише підказка: вирішує збережений стан,
 * тож компанія, яку людина заблокувала, «restored» не побачить, як і всі,
 * коли прапор увімкнено без згоди чи без ролі. Нотатки, теги, історія й уже
 * відкритий контакт лишаються; відкрите знайомство теж (кандидат може відповісти).
 */
export async function onVisibilityChanged(
  userId: string,
  _visible: boolean,
  database: D1Database = requestDb(),
  now: Date = new Date(),
): Promise<{ cards: number }> {
  return syncVisibilityEvents(userId, database, now);
}

export const ERASED_SUBJECT = "A candidate you were in contact with deleted their account";

function erasedText(label: string): string {
  return (
    `A candidate you were in contact with (${label}) deleted their account. ` +
    "Please delete any copy of their contact details you keep outside NextCryptoJob."
  );
}

export interface ErasureNotice {
  /** Скільки листів пішло і скільки не вдалося. */
  mailed: number;
  mailFailed: number;
  /** Власники компаній з відкритим контактом, яким писати нікуди (вхід лише Telegram). */
  ownersWithoutEmail: number;
}

export interface ErasureResult extends ErasureNotice {
  /** Компанії з карткою чи знайомством цієї людини (рядок журналу candidate.erased кожній). */
  companies: number;
  /** З них ті, кому людина відкрила контакт (їм лист власникам, GDPR ст. 19). */
  contactShared: number;
}

export interface ErasurePlan {
  companies: number;
  contactShared: number;
  /**
   * Інструкції для пакета викликача ПЕРЕД `DELETE FROM users` (той самий пакет):
   * 1) людина зникає для компаній (visible_to_companies = 0);
   * 2) `candidate.erased` у журнал кожної компанії з карткою або знайомством
   *    (`meta.contact_shared` каже, чи був відкритий контакт);
   * 3) відкриті знайомства → `canceled`.
   */
  statements: D1PreparedStatement[];
  /** Листи власникам компаній з відкритим контактом. Викликати лише ПІСЛЯ коміту пакета. */
  notify: () => Promise<ErasureNotice>;
}

/**
 * План видалення кандидата (специфікація 11). Отримувачів листа читає зараз,
 * поки знайомства ще є (каскад DELETE users їх прибере). Картки, історію,
 * нотатки й знайомства видаляє каскад: нотатки компанії не лишаються (5.4, 11).
 */
export async function candidateErasurePlan(
  userId: string,
  opts: { db?: D1Database; mailer?: Mailer | null; now?: Date } = {},
): Promise<ErasurePlan> {
  const database = opts.db ?? requestDb();
  const at = sqlTime(opts.now ?? new Date());

  const [countRes, ownerRes] = await database.batch([
    database
      .prepare(
        `SELECT COUNT(*) AS companies,
                COALESCE(SUM(EXISTS (SELECT 1 FROM intros i WHERE i.company_id = c.company_id AND i.user_id = ?
                                        AND i.status IN ('accepted', 'direct') AND i.contact_value IS NOT NULL)), 0) AS shared
           FROM (SELECT company_id FROM pipeline WHERE user_id = ? UNION SELECT company_id FROM intros WHERE user_id = ?) c`,
      )
      .bind(userId, userId, userId),
    database
      .prepare(
        `SELECT DISTINCT m.user_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
          WHERE m.role = 'owner' AND u.id <> ?
            AND m.company_id IN (SELECT i.company_id FROM intros i
                                  WHERE i.user_id = ? AND i.status IN ('accepted', 'direct') AND i.contact_value IS NOT NULL)`,
      )
      .bind(userId, userId),
  ]);
  const counts = countRes.results[0] as { companies: number; shared: number } | undefined;
  const owners = ownerRes.results as { user_id: string; email: string | null }[];
  const emails = [...new Set(owners.map((o) => o.email?.trim() ?? "").filter((e) => e !== ""))];
  const ownersWithoutEmail = owners.filter((o) => !o.email?.trim()).length;

  const statements = [
    database.prepare("UPDATE users SET visible_to_companies = 0 WHERE id = ?").bind(userId),
    database
      .prepare(
        `INSERT INTO audit_log (actor, action, target, meta_json, at)
         SELECT c.company_id || ':system', 'candidate.erased', ?,
                json_object('company_id', c.company_id,
                            'contact_shared', json(CASE WHEN EXISTS (
                                SELECT 1 FROM intros i WHERE i.company_id = c.company_id AND i.user_id = ?
                                   AND i.status IN ('accepted', 'direct') AND i.contact_value IS NOT NULL)
                              THEN 'true' ELSE 'false' END),
                            'intro_canceled', json(CASE WHEN EXISTS (
                                SELECT 1 FROM intros i WHERE i.company_id = c.company_id AND i.user_id = ? AND i.status = 'pending')
                              THEN 'true' ELSE 'false' END)),
                ?
           FROM (SELECT company_id FROM pipeline WHERE user_id = ? UNION SELECT company_id FROM intros WHERE user_id = ?) c
          ORDER BY c.company_id`,
      )
      .bind(userId, userId, userId, at, userId, userId),
    database
      .prepare(
        `UPDATE intros SET status = 'canceled', respond_token_hash = NULL, updated_at = ?
          WHERE user_id = ? AND status = 'pending'`,
      )
      .bind(at, userId),
  ];

  const notify = async (): Promise<ErasureNotice> => {
    let mailed = 0;
    let mailFailed = 0;
    if (emails.length) {
      const mailer = opts.mailer !== undefined ? opts.mailer : getMailer(appEnv());
      const text = erasedText(candidateLabel(userId));
      if (!mailer) {
        mailFailed = emails.length;
        console.error("crm: erasure notices not sent: not configured: EMAIL");
      } else {
        for (const email of emails) {
          try {
            await mailer.send({ to: email, subject: ERASED_SUBJECT, text, html: `<p>${text}</p>` });
            mailed++;
          } catch (error) {
            mailFailed++;
            console.error("crm: erasure notice was not sent", error instanceof Error ? error.message : error);
          }
        }
      }
    }
    return { mailed, mailFailed, ownersWithoutEmail };
  };

  return { companies: counts?.companies ?? 0, contactShared: counts?.shared ?? 0, statements, notify };
}

/**
 * Перед DELETE рядка users, окремим пакетом (так його кличе доріжка налаштувань):
 * план → коміт → листи. Краще передати plan.statements у пакет з самим DELETE
 * (candidateErasurePlan) і кликати notify() після нього.
 * Лист не зупиняє видалення: право на видалення важливіше, а обов'язок записано в журнал.
 * Помилка бази кидається далі, і тоді листів немає: краще не видалити, ніж видалити мовчки.
 */
export async function beforeCandidateErased(
  userId: string,
  opts: { db?: D1Database; mailer?: Mailer | null; now?: Date } = {},
): Promise<ErasureResult> {
  const database = opts.db ?? requestDb();
  const plan = await candidateErasurePlan(userId, { ...opts, db: database });
  await database.batch(plan.statements);
  const notice = await plan.notify();
  return { companies: plan.companies, contactShared: plan.contactShared, ...notice };
}

export const LAST_OWNER_TEXT = "Make someone else an owner or close the company first.";

/**
 * Причина, чому акаунт видаляти не можна, або null (специфікація 6.3, 13):
 * людина єдиний власник компанії, що працює або чекає перевірки. Призупинену
 * чи відхилену компанію передати нікому, тож вона видалення не тримає.
 */
export async function erasureBlockReason(userId: string, database: D1Database = requestDb()): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT 1 AS blocked FROM company_members m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = ? AND m.role = 'owner' AND c.status IN ('active', 'pending_review')
          AND NOT EXISTS (SELECT 1 FROM company_members o
                           WHERE o.company_id = m.company_id AND o.role = 'owner'
                             AND o.user_id IS NOT NULL AND o.user_id <> m.user_id)
        LIMIT 1`,
    )
    .bind(userId)
    .first<{ blocked: number }>();
  return row ? LAST_OWNER_TEXT : null;
}

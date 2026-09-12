import type { z } from "zod";
import { isRoleKey } from "@/lib/card/roles";
import { randomToken, safeEqual, sha256Hex } from "@/lib/auth/hash";
import { newId } from "@/lib/ids";
import { fromSqlTime, isoTime, sqlTime } from "@/lib/time";
import { auditActor, auditStatement, systemAuditActor } from "./audit";
import type { ActionContext, CompanyInfo } from "./context";
import {
  ANSWER_TEXT,
  deliver,
  directRevealMessage,
  introAcceptedMessage,
  introDate,
  introExpiredMessage,
  introRequestMessage,
  notifierFromEnv,
  type IntroRequestDetails,
  type Notifier,
  type OutgoingMessage,
  type Recipient,
} from "./notify";
import { addToPipeline, introStageMove, introTransitionStatements, type IntroEvent, type IntroTransition } from "./pipeline";
import { INTRO_COLUMNS, projectIntro, type IntroRow } from "./project";
import { ActionError, type Intro, type IntroList as IntroListSchema, type RoleKey, type Stage } from "./types";
import { isVisibleTo, visibilitySyncStatements, visibleToSql } from "./visibility";

/**
 * Знайомства (специфікація CRM, 5.5 і 11): компанія просить, кандидат вирішує,
 * контакт відкривається лише після «так» (або одразу в режимі direct, який
 * кандидат увімкнув сам).
 *
 * Створення (request_intro). checkIntroRequest робить УСІ перевірки й нічого не
 * пише; реєстр кличе його в reserve(), тобто до квоти й до розрахунку x402:
 * 1. видимість для компанії (3.4): інакше 409 candidate_not_visible (картка є)
 *    або 404 candidate_not_available;
 * 2. відкритого немає (intro_already_open); відмови за 90 днів немає і запитів
 *    за 90 днів менше 2 (intro_cooldown з details.retry_after);
 * 3. повідомлення 20–600 символів без пробілів по краях; агенція мусить назвати
 *    "Hiring for"; job_id лише своя відкрита вакансія; картку можна перевести
 *    (introStageMove кидає, якщо картка не на found);
 * 4. режим: direct, коли contact_mode = 'direct', є Telegram-нік і чинна згода
 *    contact; інакше approval.
 * Потім (після settle) один DB.batch: INSERT intros (expires_at +14 днів,
 * SHA-256 одноразового токена відповіді), журнал, подія й етап картки.
 * Сповіщення кандидату йде після коміту; не дійшло нікуди → notify_error.
 *
 * Пакети знайомства атомарні: умови, які могли змінитися між читанням і
 * записом, перевіряє сам пакет, і хибна умова дає NOT NULL у рядку intros
 * (CASE WHEN умова THEN значення END). Така помилка відкочує ВЕСЬ пакет
 * (D1 batch = одна транзакція), тож не буває знайомства без руху картки,
 * руху картки без знайомства чи двох відповідей на одне знайомство.
 *
 * Відповідь кандидата (respondToIntro): Telegram-кнопка, сторінка /intro/[id]
 * з токеном з листа або з сесією. UPDATE ставить новий статус лише з pending
 * і не пізніше expires_at (інакше NOT NULL і відкат): подвійне натискання дає
 * один успіх, друге бачить "You already answered this request.".
 */

export const INTRO_TTL_DAYS = 14;
export const INTRO_COOLDOWN_DAYS = 90;
export const MAX_INTROS_PER_COOLDOWN = 2;
const DAY_MS = 86_400_000;

type CompanyCtx = ActionContext & { company: CompanyInfo };
type EventActor = NonNullable<IntroTransition["actor"]>;

function companyActor(ctx: ActionContext): { ctx: CompanyCtx; actor: EventActor } {
  const company = ctx.company;
  if (!company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  if (ctx.actor.kind === "member") {
    return { ctx: ctx as CompanyCtx, actor: { kind: "member", userId: ctx.actor.userId, keyId: null } };
  }
  if (ctx.actor.kind === "agent") {
    return { ctx: ctx as CompanyCtx, actor: { kind: "agent", userId: null, keyId: ctx.actor.keyId } };
  }
  throw new ActionError("forbidden", 403, "Only company members and agents can request intros.");
}

function daysBefore(now: Date, days: number): string {
  return sqlTime(new Date(now.getTime() - days * DAY_MS));
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint failed/i.test(error.message);
}

const conflict = () =>
  new ActionError("invalid_stage_transition", 409, "This card changed in the meantime. Reload it and try again.");

/** '@handle' з users.telegram_username або null. */
export function telegramHandle(username: string | null): string | null {
  const bare = (username ?? "").trim().replace(/^@+/, "");
  return bare ? `@${bare}` : null;
}

/** Що відкриється компанії після «так»: Telegram-нік, інакше пошта, інакше нічого. */
export function candidateContact(u: { telegram_username: string | null; email: string | null }):
  | { kind: "telegram" | "email"; value: string }
  | null {
  const handle = telegramHandle(u.telegram_username);
  if (handle) return { kind: "telegram", value: handle };
  const email = u.email?.trim();
  return email ? { kind: "email", value: email } : null;
}

/** a***@gmail.com: скільки треба, щоб людина впізнала свою адресу, і не більше. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

// ---------------------------------------------------------------------------
// Картка й пакет знайомства

interface CardRef {
  id: number;
  stage: Stage;
  role: string | null;
}

async function readCard(db: D1Database, companyId: string, candidateId: string): Promise<CardRef | null> {
  return db
    .prepare("SELECT id, stage, role FROM pipeline WHERE company_id = ? AND user_id = ?")
    .bind(companyId, candidateId)
    .first<CardRef>();
}

/**
 * Запобіжник пакета: хибна умова ставить intros.message у NULL, NOT NULL
 * кидає, і D1 відкочує весь пакет.
 */
function assertion(db: D1Database, introId: string, condition: string, params: (string | number)[]): D1PreparedStatement {
  return db
    .prepare(`UPDATE intros SET message = CASE WHEN ${condition} THEN message END WHERE id = ?`)
    .bind(...params, introId);
}

/**
 * Пакет знайомства: свої записи (lead), перехід картки з pipeline.ts
 * (introTransitionStatements: подія, журнал pipeline.stage, етап), хвіст і
 * наприкінці запобіжник «картка стоїть там, куди мала стати». Картку
 * змінили між читанням і пакетом → запобіжник кидає → нічого не записано.
 */
async function runIntroBatch(
  db: D1Database,
  introId: string,
  lead: D1PreparedStatement[],
  transition: IntroTransition,
  tail: D1PreparedStatement[] = [],
): Promise<void> {
  const card = await readCard(db, transition.companyId, transition.candidateId);
  const moves = await introTransitionStatements(db, transition);
  const writes = [...lead, ...moves, ...tail];
  if (card) {
    const expected = introStageMove(card.stage, transition.event)?.to ?? card.stage;
    writes.push(assertion(db, introId, "EXISTS (SELECT 1 FROM pipeline WHERE id = ? AND stage = ?)", [card.id, expected]));
  }
  await db.batch(writes);
}

/** Вебхук у чергу (доставляє T11): лише коли в компанії є ввімкнений вебхук. */
function webhookQueue(event: "intro.accepted" | "intro.declined" | "intro.expired", at: string) {
  const hook = `EXISTS (SELECT 1 FROM companies wc
                        WHERE wc.id = intros.company_id AND wc.webhook_enabled = 1 AND wc.webhook_url IS NOT NULL)`;
  return {
    sql: `webhook_state = CASE WHEN ${hook} THEN 'pending' ELSE 'none' END, webhook_event = ?, webhook_attempts = 0,
          webhook_last_error = NULL, webhook_next_at = CASE WHEN ${hook} THEN ? END`,
    params: [event, at],
  };
}

// ---------------------------------------------------------------------------
// Створення

export interface IntroInput {
  candidate_id: string;
  message: string;
  role?: RoleKey;
  job_id?: string;
  hiring_for?: string;
}

export interface IntroPlan {
  mode: "approval" | "direct";
  card: CardRef | null;
  message: string;
  role: RoleKey | null;
  jobId: string | null;
  hiringFor: string | null;
  /** Знімок контакту для режиму direct ('@handle'). */
  contactValue: string | null;
}

function cooldownError(retry: Date, text: string): ActionError {
  const retryAfter = isoTime(sqlTime(retry));
  return new ActionError("intro_cooldown", 409, `${text} Try again after ${introDate(sqlTime(retry))}.`, {
    retry_after: retryAfter,
  });
}

/**
 * Усі перевірки створення (5.5, кроки 1–4) без жодного запису. Кидає ActionError
 * з кодом договору; інакше план для requestIntro.
 */
export async function checkIntroRequest(rawCtx: ActionContext, input: IntroInput): Promise<IntroPlan> {
  const { ctx } = companyActor(rawCtx);
  const { db, company } = ctx;
  const id = input.candidate_id;
  const card = await readCard(db, company.id, id);

  // 1. Видимість. Блок і членство в команді виглядають так само, як невидимість.
  if (!(await isVisibleTo(db, id, company.id))) {
    throw card
      ? new ActionError("candidate_not_visible", 409, "This candidate is no longer visible, so you cannot request an intro.")
      : new ActionError("candidate_not_available", 404, "This candidate is not available.");
  }

  // 2. Відкрите знайомство і кулдауни.
  const cutoff = daysBefore(ctx.now, INTRO_COOLDOWN_DAYS);
  const [openRes, declinedRes, recentRes] = await db.batch([
    db.prepare("SELECT id FROM intros WHERE company_id = ? AND user_id = ? AND status = 'pending' LIMIT 1").bind(company.id, id),
    db
      .prepare(
        `SELECT MAX(COALESCE(responded_at, updated_at)) AS at FROM intros
          WHERE company_id = ? AND user_id = ? AND status = 'declined' AND COALESCE(responded_at, updated_at) > ?`,
      )
      .bind(company.id, id, cutoff),
    db
      .prepare(
        `SELECT created_at FROM intros WHERE company_id = ? AND user_id = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT ${MAX_INTROS_PER_COOLDOWN}`,
      )
      .bind(company.id, id, cutoff),
  ]);
  const open = openRes.results[0] as { id: string } | undefined;
  if (open) {
    throw new ActionError("intro_already_open", 409, "An intro to this candidate is already open. Wait for the answer or withdraw it.", {
      intro_id: open.id,
    });
  }
  const declinedAt = (declinedRes.results[0] as { at: string | null } | undefined)?.at ?? null;
  if (declinedAt) {
    throw cooldownError(
      new Date(fromSqlTime(declinedAt).getTime() + INTRO_COOLDOWN_DAYS * DAY_MS),
      "This candidate declined your last intro request.",
    );
  }
  const recent = recentRes.results as { created_at: string }[];
  if (recent.length >= MAX_INTROS_PER_COOLDOWN) {
    // Коли вийде з вікна друге найновіше, лишиться один запит.
    const oldest = recent[MAX_INTROS_PER_COOLDOWN - 1].created_at;
    throw cooldownError(
      new Date(fromSqlTime(oldest).getTime() + INTRO_COOLDOWN_DAYS * DAY_MS),
      `You can send at most ${MAX_INTROS_PER_COOLDOWN} intro requests to one candidate in ${INTRO_COOLDOWN_DAYS} days.`,
    );
  }

  // 3. Поля.
  const fields: Record<string, string> = {};
  const message = input.message.trim();
  if (message.length < 20) fields.message = "Write at least 20 characters.";
  let hiringFor: string | null = null;
  if (company.kind === "agency") {
    const h = (input.hiring_for ?? "").replace(/\s+/g, " ").trim();
    if (h.length < 2) fields.hiring_for = 'Agencies must say who they are hiring for, or write "Confidential client".';
    else hiringFor = h;
  }
  if (Object.keys(fields).length) throw new ActionError("validation_failed", 422, "Some fields are not valid.", { fields });

  let jobRoles: string[] = [];
  if (input.job_id) {
    const job = await db
      .prepare("SELECT status, expires_at, roles FROM company_jobs WHERE id = ? AND company_id = ?")
      .bind(input.job_id, company.id)
      .first<{ status: string; expires_at: string | null; roles: string }>();
    if (!job) throw new ActionError("not_found", 404, "This job was not found.");
    if (job.status !== "open" || !job.expires_at || job.expires_at <= sqlTime(ctx.now)) {
      throw new ActionError("validation_failed", 422, "Some fields are not valid.", {
        fields: { job_id: "Link one of your open jobs." },
      });
    }
    try {
      const parsed: unknown = JSON.parse(job.roles);
      if (Array.isArray(parsed)) jobRoles = parsed.filter((r): r is string => typeof r === "string");
    } catch {
      // Зіпсований список ролей вакансії: роль лишиться невідомою.
    }
  }

  // 4. Режим.
  const person = await db
    .prepare(
      `SELECT u.contact_mode, u.telegram_username,
              EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.kind = 'contact' AND c.granted = 1) AS contact_consent
         FROM users u WHERE u.id = ?`,
    )
    .bind(id)
    .first<{ contact_mode: string; telegram_username: string | null; contact_consent: number }>();
  const handle = telegramHandle(person?.telegram_username ?? null);
  const mode = person?.contact_mode === "direct" && handle && person.contact_consent === 1 ? "direct" : "approval";

  // Картку можна перевести (кидає invalid_stage_transition, якщо ні). Без картки вона стане found.
  introStageMove(card?.stage ?? "found", mode === "direct" ? "contact_shared" : "intro_requested");

  const cardRole = card?.role && isRoleKey(card.role) ? card.role : null;
  const jobRole = jobRoles.find((r) => isRoleKey(r)) as RoleKey | undefined;
  return {
    mode,
    card,
    message,
    role: input.role ?? cardRole ?? jobRole ?? null,
    jobId: input.job_id ?? null,
    hiringFor,
    contactValue: mode === "direct" ? handle : null,
  };
}

async function introRowFor(db: D1Database, companyId: string, introId: string): Promise<IntroRow | null> {
  return db
    .prepare(`SELECT ${INTRO_COLUMNS} FROM intros WHERE id = ? AND company_id = ?`)
    .bind(introId, companyId)
    .first<IntroRow>();
}

/**
 * Створити знайомство (обробник request_intro). Викликати після reserve()
 * (перевірки й квота) і після settle, якщо платить x402. Без картки спершу
 * додає кандидата у воронку (found), далі один пакет: знайомство, журнал,
 * подія, етап intro_requested (або contact_shared для direct). Потім сповіщення.
 */
export async function requestIntro(rawCtx: ActionContext, input: IntroInput): Promise<{ intro: Intro; mode: IntroPlan["mode"] }> {
  const { ctx, actor } = companyActor(rawCtx);
  const { db, company } = ctx;
  let plan = await checkIntroRequest(ctx, input);
  if (!plan.card) {
    await addToPipeline(ctx, { candidate_id: input.candidate_id, role: plan.role ?? undefined, job_id: plan.jobId ?? undefined });
    plan = await checkIntroRequest(ctx, input);
  }
  const card = plan.card;
  if (!card) throw conflict();

  const direct = plan.mode === "direct";
  const introId = newId("int");
  const at = sqlTime(ctx.now);
  const token = direct ? null : randomToken();
  const tokenHash = token ? await sha256Hex(token) : null;
  const expiresAt = sqlTime(new Date(ctx.now.getTime() + INTRO_TTL_DAYS * DAY_MS));
  const cutoff = daysBefore(ctx.now, INTRO_COOLDOWN_DAYS);

  // Ті самі правила, що в checkIntroRequest, у мить запису (відкрите знайомство ловить uq_intros_open).
  const v = visibleToSql(company.id);
  const guards = [
    v.sql,
    "EXISTS (SELECT 1 FROM pipeline gp WHERE gp.id = ? AND gp.stage = ?)",
    `NOT EXISTS (SELECT 1 FROM intros gd WHERE gd.company_id = ? AND gd.user_id = u.id AND gd.status = 'declined'
                   AND COALESCE(gd.responded_at, gd.updated_at) > ?)`,
    "(SELECT COUNT(*) FROM intros gc WHERE gc.company_id = ? AND gc.user_id = u.id AND gc.created_at > ?) < ?",
  ];
  const guardParams: (string | number)[] = [
    ...(v.params as (string | number)[]),
    card.id,
    card.stage,
    company.id,
    cutoff,
    company.id,
    cutoff,
    MAX_INTROS_PER_COOLDOWN,
  ];
  if (direct) {
    guards.push(
      `u.contact_mode = 'direct' AND trim(COALESCE(u.telegram_username, '')) <> ''
       AND EXISTS (SELECT 1 FROM consents gk WHERE gk.user_id = u.id AND gk.kind = 'contact' AND gk.granted = 1)`,
    );
  }
  const insert = db
    .prepare(
      `INSERT INTO intros (id, company_id, user_id, pipeline_id, job_id, role, mode, status, message, hiring_for,
                           requested_via, requested_by_user_id, requested_by_key_id, x402_payment_id, respond_token_hash,
                           expires_at, responded_at, contact_kind, contact_value, created_at, updated_at)
       SELECT ?, ?, u.id, ?, ?, ?, ?, ?, CASE WHEN ${guards.map((g) => `(${g})`).join(" AND ")} THEN ? END, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT 1) AS one LEFT JOIN users u ON u.id = ?`,
    )
    .bind(
      introId,
      company.id,
      card.id,
      plan.jobId,
      plan.role,
      plan.mode,
      direct ? "direct" : "pending",
      ...guardParams,
      plan.message,
      plan.hiringFor,
      ctx.channel,
      actor.userId,
      actor.keyId,
      ctx.payment?.id ?? null,
      tokenHash,
      expiresAt,
      direct ? at : null,
      direct ? "telegram" : null,
      direct ? plan.contactValue : null,
      at,
      at,
      input.candidate_id,
    );
  const audit = auditStatement(ctx, {
    action: direct ? "contact.reveal" : "intro.request",
    target: input.candidate_id,
    meta: {
      intro_id: introId,
      mode: plan.mode,
      role: plan.role,
      job_id: plan.jobId,
      payment_id: ctx.payment?.id ?? null,
    },
  });

  try {
    await runIntroBatch(db, introId, [insert, audit], {
      companyId: company.id,
      candidateId: input.candidate_id,
      event: direct ? "contact_shared" : "intro_requested",
      introId,
      now: ctx.now,
      actor,
      auditActor: auditActor(ctx.actor),
    });
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    // Щось змінилось між перевіркою і записом: та сама перевірка назве що саме.
    await checkIntroRequest(ctx, input);
    throw conflict();
  }

  await notifyCandidate(db, introId, token, notifierFromEnv(ctx.env), ctx.now);
  const row = await introRowFor(db, company.id, introId);
  if (!row) throw new ActionError("internal", 500, "Something went wrong on our side. Try again later.");
  return { intro: projectIntro(row), mode: plan.mode };
}

// ---------------------------------------------------------------------------
// Сповіщення

/** Рядок знайомства з усім, що бачить кандидат (сповіщення, сторінка, кнопки). */
export interface CandidateIntroRow {
  id: string;
  company_id: string;
  user_id: string;
  status: Intro["status"];
  mode: Intro["mode"];
  message: string;
  hiring_for: string | null;
  role: string | null;
  job_id: string | null;
  expires_at: string;
  respond_token_hash: string | null;
  company_name: string;
  company_domain: string | null;
  company_domain_verified: number;
  company_about: string | null;
  job_title: string | null;
  channel: "email" | "telegram";
  telegram_id: string | null;
  telegram_username: string | null;
  email: string | null;
}

export async function candidateIntroRow(db: D1Database, introId: string): Promise<CandidateIntroRow | null> {
  return db
    .prepare(
      `SELECT i.id, i.company_id, i.user_id, i.status, i.mode, i.message, i.hiring_for, i.role, i.job_id, i.expires_at,
              i.respond_token_hash,
              c.name AS company_name, c.domain AS company_domain,
              (c.domain_verified_at IS NOT NULL) AS company_domain_verified, c.about AS company_about,
              j.title AS job_title,
              u.channel, u.telegram_id, u.telegram_username, u.email
         FROM intros i
         JOIN companies c ON c.id = i.company_id
         JOIN users u ON u.id = i.user_id
         LEFT JOIN company_jobs j ON j.id = i.job_id AND j.company_id = i.company_id
        WHERE i.id = ?`,
    )
    .bind(introId)
    .first<CandidateIntroRow>();
}

export function requestDetails(row: CandidateIntroRow): IntroRequestDetails {
  return {
    introId: row.id,
    companyName: row.company_name,
    domain: row.company_domain,
    domainVerified: row.company_domain_verified === 1,
    role: row.role,
    message: row.message,
    hiringFor: row.hiring_for,
    jobId: row.job_id,
    jobTitle: row.job_title,
    expiresAt: row.expires_at,
  };
}

function recipientOf(row: { channel: "email" | "telegram"; telegram_id: string | null; email: string | null }): Recipient {
  return { channel: row.channel, telegramId: row.telegram_id, email: row.email?.trim() || null };
}

/**
 * Запит (або повідомлення direct) кандидату і запис, чим дійшло:
 * notify_channel + notified_at, або notify_error. Ніколи не кидає: знайомство
 * вже створене (і, можливо, оплачене), а компанія побачить NOT_REACHED_TEXT.
 * updated_at не чіпаємо: list_intros?updated_since стежить за станом, не за доставкою.
 */
async function notifyCandidate(db: D1Database, introId: string, token: string | null, n: Notifier, now: Date): Promise<void> {
  let channel: "email" | "telegram" | null = null;
  let error: string | null = null;
  try {
    const row = await candidateIntroRow(db, introId);
    if (!row) return;
    const message: OutgoingMessage =
      row.status === "direct" ? directRevealMessage(row.company_name) : introRequestMessage(requestDetails(row), n.origin, token);
    const res = await deliver(recipientOf(row), message, n);
    if (res.ok) channel = res.channel;
    else error = res.error;
  } catch (e) {
    error = `internal: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    console.error("crm: intro notification failed", { introId, error });
  }
  try {
    await db
      .prepare("UPDATE intros SET notify_channel = ?, notified_at = ?, notify_error = ? WHERE id = ?")
      .bind(channel, channel ? sqlTime(now) : null, error, introId)
      .run();
  } catch (e) {
    console.error("crm: intro notification outcome not recorded", { introId, error: e instanceof Error ? e.message : e });
  }
}

/**
 * Лист чи повідомлення тому, хто просив (член команди, якщо він досі в
 * компанії), інакше власникам (запит агента). Контакту в тексті немає.
 */
export async function notifyRequester(
  db: D1Database,
  introId: string,
  kind: "accepted" | "expired",
  n: Notifier,
): Promise<number> {
  try {
    const intro = await db
      .prepare("SELECT company_id, user_id, requested_by_user_id FROM intros WHERE id = ?")
      .bind(introId)
      .first<{ company_id: string; user_id: string; requested_by_user_id: string | null }>();
    if (!intro) return 0;
    type Person = { channel: "email" | "telegram"; telegram_id: string | null; email: string | null };
    let people: Person[] = [];
    if (intro.requested_by_user_id) {
      const res = await db
        .prepare(
          `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
            WHERE m.company_id = ? AND m.user_id = ?`,
        )
        .bind(intro.company_id, intro.requested_by_user_id)
        .all<Person>();
      people = res.results;
    }
    if (people.length === 0) {
      const res = await db
        .prepare(
          `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
            WHERE m.company_id = ? AND m.role = 'owner' ORDER BY m.id`,
        )
        .bind(intro.company_id)
        .all<Person>();
      people = res.results;
    }
    const message =
      kind === "accepted" ? introAcceptedMessage(intro.user_id, n.origin) : introExpiredMessage(intro.user_id, n.origin);
    let sent = 0;
    for (const p of people) {
      const res = await deliver(recipientOf(p), message, n);
      if (res.ok) sent++;
      else console.warn("crm: requester not notified", { introId, kind, error: res.error });
    }
    return sent;
  } catch (e) {
    console.error("crm: requester notification failed", { introId, kind, error: e instanceof Error ? e.message : e });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Відповідь кандидата

export type IntroDecision = "accept" | "decline" | "block";

export type RespondOutcome =
  | { kind: "accepted"; companyName: string; contactKind: "telegram" | "email" }
  | { kind: "declined"; companyName: string; blocked: boolean }
  | { kind: "answered" | "expired" | "withdrawn" | "not_found" | "not_yours" | "no_contact" };

/** Стан знайомства для кандидата. `revealed` = режим direct (відповідати нема на що). */
export type CandidateIntroState = "pending" | "answered" | "expired" | "withdrawn" | "revealed";

export function candidateState(row: { status: Intro["status"]; expires_at: string }, now: Date): CandidateIntroState {
  switch (row.status) {
    case "pending":
      return row.expires_at > sqlTime(now) ? "pending" : "expired";
    case "accepted":
    case "declined":
      return "answered";
    case "expired":
      return "expired";
    case "canceled":
      return "withdrawn";
    case "direct":
      return "revealed";
  }
}

/** Відповідь для знайомства, що вже не чекає (для тексту кандидату). */
export function outcomeForState(state: Exclude<CandidateIntroState, "pending">): RespondOutcome {
  return { kind: state === "revealed" ? "answered" : state };
}

/** Текст відповіді кандидату (бот і сторінка). Простий текст. */
export function answerText(outcome: RespondOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return ANSWER_TEXT.accepted(outcome.companyName, outcome.contactKind);
    case "declined":
      return outcome.blocked ? ANSWER_TEXT.blocked(outcome.companyName) : ANSWER_TEXT.declined(outcome.companyName);
    case "answered":
      return ANSWER_TEXT.alreadyAnswered;
    case "expired":
      return ANSWER_TEXT.expired;
    case "withdrawn":
      return ANSWER_TEXT.withdrawn;
    case "no_contact":
      return ANSWER_TEXT.noContact;
    case "not_yours":
      return ANSWER_TEXT.notYours;
    case "not_found":
      return ANSWER_TEXT.invalid;
  }
}

export interface RespondArgs {
  introId: string;
  /** Кандидат, якого вже впізнали (Telegram from.id, сесія або токен з листа). */
  userId: string;
  decision: IntroDecision;
  via: "telegram" | "web";
  notifier: Notifier;
  now?: Date;
}

/**
 * Відповідь кандидата однією транзакцією. «Accept»: знімок контакту (Telegram-нік,
 * інакше пошта), картка → contact_shared, вебхук intro.accepted у чергу, потім
 * повідомлення тому, хто просив (без контакту). «Decline»: картка → declined
 * (candidate). «Decline and block»: ще candidate_blocked = 1 і visibility_lost
 * у картці цієї компанії (інші компанії людину бачать далі).
 */
export async function respondToIntro(db: D1Database, args: RespondArgs): Promise<RespondOutcome> {
  const now = args.now ?? new Date();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await candidateIntroRow(db, args.introId);
    if (!row) return { kind: "not_found" };
    if (row.user_id !== args.userId) return { kind: "not_yours" };
    const state = candidateState(row, now);
    if (state !== "pending") return outcomeForState(state);

    const accept = args.decision === "accept";
    const contact = accept ? candidateContact(row) : null;
    if (accept && !contact) return { kind: "no_contact" };

    const at = sqlTime(now);
    const hook = webhookQueue(accept ? "intro.accepted" : "intro.declined", at);
    const blocked = args.decision === "block";
    const update = db
      .prepare(
        `UPDATE intros
            SET status = CASE WHEN status = 'pending' AND expires_at > ? THEN ? END,
                responded_at = ?, updated_at = ?, respond_token_hash = NULL,
                candidate_blocked = CASE WHEN ? = 1 THEN 1 ELSE candidate_blocked END,
                contact_kind = ?, contact_value = ?,
                ${hook.sql}
          WHERE id = ? AND user_id = ?`,
      )
      .bind(
        at,
        accept ? "accepted" : "declined",
        at,
        at,
        blocked ? 1 : 0,
        contact?.kind ?? null,
        contact?.value ?? null,
        ...hook.params,
        row.id,
        row.user_id,
      );
    const actorLabel = `${row.company_id}:candidate`;
    const audit = db
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, ?, ?, ?, ?)")
      .bind(
        actorLabel,
        accept ? "intro.accept" : "intro.decline",
        row.user_id,
        JSON.stringify({ company_id: row.company_id, intro_id: row.id, via: args.via, blocked }),
        at,
      );
    const event: IntroEvent = accept ? "intro_accepted" : "intro_declined";
    try {
      await runIntroBatch(
        db,
        row.id,
        [update, audit],
        {
          companyId: row.company_id,
          candidateId: row.user_id,
          event,
          introId: row.id,
          now,
          actor: { kind: "candidate", userId: row.user_id, keyId: null },
          auditActor: actorLabel,
        },
        // Блок робить людину невидимою для цієї компанії: visibility_lost у її картці.
        blocked ? visibilitySyncStatements(db, row.user_id, now) : [],
      );
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      continue; // інше натискання чи прострочення встигло раніше: новий стан скаже наступне читання
    }
    if (accept) {
      await notifyRequester(db, row.id, "accepted", args.notifier);
      return { kind: "accepted", companyName: row.company_name, contactKind: contact!.kind };
    }
    return { kind: "declined", companyName: row.company_name, blocked };
  }
  const row = await candidateIntroRow(db, args.introId);
  const state = row ? candidateState(row, now) : null;
  if (state && state !== "pending") return outcomeForState(state);
  throw new ActionError("internal", 500, "Something went wrong on our side. Try again later.");
}

export type CandidateAuth = "session" | "token" | null;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Хто відповідає: власник сесії = кандидат, або чинний токен з листа (лише поки знайомство чекає). */
export async function authorizeCandidate(
  row: Pick<CandidateIntroRow, "user_id" | "respond_token_hash">,
  opts: { token?: string | null; sessionUserId?: string | null },
): Promise<CandidateAuth> {
  if (opts.sessionUserId && opts.sessionUserId === row.user_id) return "session";
  const token = opts.token ?? "";
  if (!row.respond_token_hash || !TOKEN_SHAPE.test(token)) return null;
  return safeEqual(await sha256Hex(token), row.respond_token_hash) ? "token" : null;
}

export type CandidateIntroView =
  | { state: "invalid" }
  | { state: "answered" | "expired" | "withdrawn" }
  | {
      state: "pending";
      auth: "session" | "token";
      details: IntroRequestDetails;
      about: string | null;
      /** Що саме побачить компанія після «так». */
      contact: { kind: "telegram" | "email"; shown: string } | null;
    };

/**
 * Дані сторінки /intro/[id] (GET нічого не пише). Стан перевіряємо ДО токена:
 * після відповіді чи скасування токен у базі стерто, а людина має побачити
 * "This request was withdrawn.", а не «хибне посилання».
 */
export async function loadIntroForCandidate(
  db: D1Database,
  introId: string,
  opts: { token?: string | null; sessionUserId?: string | null; now?: Date },
): Promise<CandidateIntroView> {
  const row = await candidateIntroRow(db, introId);
  if (!row) return { state: "invalid" };
  const state = candidateState(row, opts.now ?? new Date());
  if (state === "revealed") return { state: "invalid" };
  if (state !== "pending") return { state };
  const auth = await authorizeCandidate(row, opts);
  if (!auth) return { state: "invalid" };
  const contact = candidateContact(row);
  return {
    state: "pending",
    auth,
    details: requestDetails(row),
    about: row.company_about?.trim() || null,
    contact: contact ? { kind: contact.kind, shown: contact.kind === "email" ? maskEmail(contact.value) : contact.value } : null,
  };
}

// ---------------------------------------------------------------------------
// Скасування, прострочення, читання

const notFound = () => new ActionError("not_found", 404, "This intro was not found.");
const notPending = () => new ActionError("intro_not_pending", 409, "This intro is no longer pending.");

/** Компанія відкликає запит: canceled, картка → found, токен стерто (сторінка скаже "withdrawn"). */
export async function cancelIntro(rawCtx: ActionContext, input: { intro_id: string }): Promise<Intro> {
  const { ctx, actor } = companyActor(rawCtx);
  const { db, company } = ctx;
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await introRowFor(db, company.id, input.intro_id);
    if (!row) throw notFound();
    if (row.status !== "pending") throw notPending();
    const at = sqlTime(ctx.now);
    const update = db
      .prepare(
        `UPDATE intros SET status = CASE WHEN status = 'pending' THEN 'canceled' END, respond_token_hash = NULL, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      )
      .bind(at, row.id, company.id);
    const audit = auditStatement(ctx, { action: "intro.cancel", target: row.user_id, meta: { intro_id: row.id } });
    try {
      await runIntroBatch(db, row.id, [update, audit], {
        companyId: company.id,
        candidateId: row.user_id,
        event: "intro_canceled",
        introId: row.id,
        now: ctx.now,
        actor,
        auditActor: auditActor(ctx.actor),
      });
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      continue;
    }
    const after = await introRowFor(db, company.id, row.id);
    if (!after) throw notFound();
    return projectIntro(after);
  }
  throw notPending();
}

/**
 * Прострочити одне знайомство (cron): expired, токен стерто, картка → found
 * (якщо досі intro_requested), вебхук intro.expired у чергу, журнал системи.
 * false, якщо його вже немає в pending (відповідь чи скасування встигли).
 */
export async function expireIntro(db: D1Database, introId: string, now: Date): Promise<boolean> {
  const row = await db
    .prepare("SELECT company_id, user_id, status, expires_at FROM intros WHERE id = ?")
    .bind(introId)
    .first<{ company_id: string; user_id: string; status: string; expires_at: string }>();
  const at = sqlTime(now);
  if (!row || row.status !== "pending" || row.expires_at > at) return false;
  const hook = webhookQueue("intro.expired", at);
  const update = db
    .prepare(
      `UPDATE intros SET status = CASE WHEN status = 'pending' AND expires_at <= ? THEN 'expired' END,
              respond_token_hash = NULL, updated_at = ?, ${hook.sql}
        WHERE id = ?`,
    )
    .bind(at, at, ...hook.params, introId);
  const audit = db
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, ?, ?, ?, ?)")
    .bind(systemAuditActor(row.company_id), "intro.expire", row.user_id, JSON.stringify({ company_id: row.company_id, intro_id: introId }), at);
  try {
    await runIntroBatch(db, introId, [update, audit], {
      companyId: row.company_id,
      candidateId: row.user_id,
      event: "intro_expired",
      introId,
      now,
    });
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    return false;
  }
  return true;
}

/** Одне знайомство компанії (intro_status). Чуже → 404. */
export async function getIntro(rawCtx: ActionContext, input: { intro_id: string }): Promise<Intro> {
  const { ctx } = companyActor(rawCtx);
  const row = await introRowFor(ctx.db, ctx.company.id, input.intro_id);
  if (!row) throw notFound();
  return projectIntro(row);
}

/** Знайомство, оплачене цим платежем x402 (відповідь на ідемпотентний повтор). */
export async function findIntroByPayment(db: D1Database, companyId: string, paymentId: string): Promise<Intro | null> {
  const row = await db
    .prepare(`SELECT ${INTRO_COLUMNS} FROM intros WHERE company_id = ? AND x402_payment_id = ?`)
    .bind(companyId, paymentId)
    .first<IntroRow>();
  return row ? projectIntro(row) : null;
}

type IntroList = z.infer<typeof IntroListSchema>;

const cursorError = () =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { cursor: "This cursor is not valid." } });

function encodeCursor(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { u: string; id: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
  try {
    const c = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    if (c?.v === 1 && typeof c.u === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c.u) && typeof c.id === "string") {
      return { u: c.u, id: c.id };
    }
  } catch {
    // нижче
  }
  throw cursorError();
}

/** Знайомства компанії, найсвіжіша зміна першою; фільтр стану й updated_since для опитування. */
export async function listIntros(
  rawCtx: ActionContext,
  input: { status?: Intro["status"]; updated_since?: string; cursor?: string; limit?: number },
): Promise<IntroList> {
  const { ctx } = companyActor(rawCtx);
  const limit = input.limit ?? 50;
  const where = ["company_id = ?"];
  const params: (string | number)[] = [ctx.company.id];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.updated_since) {
    where.push("updated_at > ?");
    params.push(sqlTime(new Date(input.updated_since)));
  }
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    params.push(c.u, c.u, c.id);
  }
  const res = await ctx.db
    .prepare(
      `SELECT ${INTRO_COLUMNS}, updated_at AS cursor_u FROM intros WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<IntroRow & { cursor_u: string }>();
  const page = res.results.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => projectIntro(r)),
    next_cursor: res.results.length > limit && last ? encodeCursor({ v: 1, u: last.cursor_u, id: last.id }) : null,
  };
}

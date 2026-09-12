import type { z } from "zod";
import { isRoleKey } from "@/lib/card/roles";
import { isoTime, sqlTime } from "@/lib/time";
import { auditValues, guardedAuditStatement, systemAuditActor, type AuditMeta } from "./audit";
import type { ActionContext, CompanyInfo } from "./context";
import {
  candidateLabel,
  contactFromIntro,
  headlineOf,
  INTRO_COLUMNS,
  roleScoresOf,
  tagsOf,
  type IntroRow,
  type ScoreRow,
} from "./project";
import {
  ActionError,
  STAGES,
  tagKey,
  type Contact,
  type PipelineCard as PipelineCardSchema,
  type PipelineEvent as PipelineEventSchema,
  type PipelineEventList as PipelineEventListSchema,
  type PipelineList as PipelineListSchema,
  type RoleKey,
  type Stage,
} from "./types";
import { visibleToSql } from "./visibility";

/**
 * Воронка компанії (специфікація CRM, 5.4): одна картка на пару (компанія,
 * кандидат), етапи, теги, нотатки, історія.
 *
 * Переходи (таблиця 5.4):
 * - (немає) → found: член або агент, кандидат видимий (add_to_pipeline);
 * - found → intro_requested; будь-який → contact_shared; intro_requested →
 *   declined (кандидат) або found (прострочення, скасування): лише процес
 *   знайомства (introTransitionStatements), ніколи вручну;
 * - вручну (член, агент): будь-який, крім intro_requested, → found / declined
 *   (declined_by = company); → interview / hired лише з відкритим контактом;
 * - intro_requested → щось вручну: invalid_stage_transition "Withdraw the pending intro first.";
 * - → interview / hired без контакту: contact_not_shared.
 *
 * Кожна зміна: рядок pipeline_events + рядок audit_log + stage_changed_at /
 * updated_at одним DB.batch (одна транзакція). Записи пакета перевіряють етап,
 * з яким картку прочитано: змінилась картка між читанням і пакетом, тоді не
 * пишеться нічого (ні події, ні журналу) і дія відповідає 409.
 *
 * Теги: до 10, до 32 символів, без розрізнення регістру (Solidity = solidity),
 * зберігаються як ввели (перше написання). Нотатки лише додаються.
 * Видалення картки скасовує відкрите знайомство і видаляє картку з історією
 * (каскад pipeline_events); журнал лишається.
 *
 * Ізоляція компаній: кожен запит фільтрує company_id актора; чужа картка
 * виглядає як відсутня (404).
 */

export type PipelineCard = z.infer<typeof PipelineCardSchema>;
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
export type PipelineList = z.infer<typeof PipelineListSchema>;
export type PipelineEventList = z.infer<typeof PipelineEventListSchema>;

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 32;
export const DEFAULT_LIMIT = 50;

type EventKind = PipelineEvent["kind"];
type EventActorKind = PipelineEvent["actor"]["kind"];

// ---------------------------------------------------------------------------
// Правила переходів (чисті функції: їх перевіряє тест по всій таблиці)

/** Етапи, які ставить лише процес знайомства. */
export const SYSTEM_ONLY_STAGES: readonly Stage[] = ["intro_requested", "contact_shared"];
/** Етапи, що потребують відкритого контакту. */
const NEEDS_CONTACT: readonly Stage[] = ["interview", "hired"];

/**
 * Ручний перехід члена команди або агента. null = дозволено.
 * Той самий етап (from === to) дія не перевіряє: це не перехід.
 */
export function checkManualTransition(from: Stage, to: Stage, contactShared: boolean): ActionError | null {
  if (SYSTEM_ONLY_STAGES.includes(to)) {
    return new ActionError("invalid_stage_transition", 409, "This stage is set by the intro flow only.");
  }
  if (from === "intro_requested") {
    return new ActionError("invalid_stage_transition", 409, "Withdraw the pending intro first.");
  }
  if (NEEDS_CONTACT.includes(to) && !contactShared) {
    return new ActionError("contact_not_shared", 409, "Contact is not shared yet. Request an intro first.");
  }
  return null;
}

/** Події знайомства, що рухають картку (пише процес знайомства, T5). */
export const INTRO_EVENTS = [
  "intro_requested",
  "intro_accepted",
  "contact_shared",
  "intro_declined",
  "intro_expired",
  "intro_canceled",
] as const satisfies readonly EventKind[];
export type IntroEvent = (typeof INTRO_EVENTS)[number];

export interface StageMove {
  to: Stage;
  declinedBy: "candidate" | null;
}

/**
 * Куди подія знайомства переводить картку з етапу `from`.
 * null = етап лишається (подія лише в історії): відповідь чи прострочення
 * знайомства, коли картка вже не на intro_requested. Кидає для переходу,
 * якого таблиця не має (знайомство з картки не на found).
 */
export function introStageMove(from: Stage, event: IntroEvent): StageMove | null {
  switch (event) {
    case "intro_requested":
      if (from !== "found") {
        throw new ActionError("invalid_stage_transition", 409, "Move the card to Found before requesting an intro.");
      }
      return { to: "intro_requested", declinedBy: null };
    case "intro_accepted":
    case "contact_shared":
      return from === "contact_shared" ? null : { to: "contact_shared", declinedBy: null };
    case "intro_declined":
      return from === "intro_requested" ? { to: "declined", declinedBy: "candidate" } : null;
    case "intro_expired":
    case "intro_canceled":
      return from === "intro_requested" ? { to: "found", declinedBy: null } : null;
  }
}

// ---------------------------------------------------------------------------
// Теги

export { tagKey };

function tagsError(message: string): ActionError {
  return new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { tags: message } });
}

/**
 * Теги як ввели (без пробілів по краях), без повторів без огляду на регістр
 * (лишається перше написання), до 10 штук по 32 символи.
 */
export function normalizeTags(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = raw.trim();
    if (!tag) throw tagsError("A tag cannot be empty.");
    if (tag.length > MAX_TAG_LENGTH) throw tagsError(`A tag can have at most ${MAX_TAG_LENGTH} characters.`);
    if (/\p{Cc}/u.test(tag)) throw tagsError("A tag cannot contain control characters.");
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw tagsError(`Use at most ${MAX_TAGS} tags.`);
  return out;
}

// ---------------------------------------------------------------------------
// Рядки й запити

interface CardBase {
  id: number;
  user_id: string;
  stage: Stage;
  declined_by: "candidate" | "company" | null;
  role: string | null;
  job_id: string | null;
  tags: string;
  note_count: number;
  created_at: string;
  updated_at: string;
  stage_changed_at: string;
}

interface CardRow extends CardBase {
  user_roles: string;
  visible: number;
  open_intro_id: string | null;
  open_intro_expires_at: string | null;
}

const CARD_COLUMNS = `p.id, p.user_id, p.stage, p.declined_by, p.role, p.job_id, p.tags, p.note_count,
  p.created_at, p.updated_at, p.stage_changed_at`;

/** Картка компанії без проєкції (для перевірок і пакетів). */
async function cardBase(db: D1Database, companyId: string, candidateId: string): Promise<CardBase | null> {
  return db
    .prepare(`SELECT ${CARD_COLUMNS} FROM pipeline p WHERE p.company_id = ? AND p.user_id = ?`)
    .bind(companyId, candidateId)
    .first<CardBase>();
}

/**
 * SELECT карток компанії з живою видимістю (visibility.ts) і відкритим
 * знайомством. Параметри: спершу видимості, потім company_id.
 */
function cardSelect(companyId: string): { sql: string; params: (string | number | null)[] } {
  const v = visibleToSql(companyId);
  return {
    sql: `SELECT ${CARD_COLUMNS}, u.roles AS user_roles,
                 CASE WHEN ${v.sql} THEN 1 ELSE 0 END AS visible,
                 oi.id AS open_intro_id, oi.expires_at AS open_intro_expires_at
            FROM pipeline p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN intros oi ON oi.company_id = p.company_id AND oi.user_id = p.user_id AND oi.status = 'pending'
           WHERE p.company_id = ?`,
    params: [...v.params, companyId],
  };
}

/** Картка у формі API або null, якщо кандидата немає у воронці цієї компанії. */
export async function getCard(db: D1Database, companyId: string, candidateId: string): Promise<PipelineCard | null> {
  const sel = cardSelect(companyId);
  const row = await db
    .prepare(`${sel.sql} AND p.user_id = ?`)
    .bind(...sel.params, candidateId)
    .first<CardRow>();
  if (!row) return null;
  return (await projectCards(db, companyId, [row]))[0];
}

/**
 * Рядки → PipelineCard. Контакт (знімок у мить згоди) лишається й для
 * прихованого кандидата; бал (headline) лише для видимого: нових даних про
 * людину, що сховалась, компанія не отримує.
 */
async function projectCards(db: D1Database, companyId: string, rows: CardRow[]): Promise<PipelineCard[]> {
  if (rows.length === 0) return [];
  const ids = JSON.stringify(rows.map((r) => r.user_id));
  const visibleIds = JSON.stringify(rows.filter((r) => r.visible === 1).map((r) => r.user_id));
  const [contactRes, scoreRes] = await db.batch([
    db
      .prepare(
        `SELECT ${INTRO_COLUMNS} FROM intros
          WHERE company_id = ? AND user_id IN (SELECT value FROM json_each(?))
            AND status IN ('accepted', 'direct') AND contact_value IS NOT NULL
          ORDER BY COALESCE(responded_at, created_at) DESC, id DESC`,
      )
      .bind(companyId, ids),
    db
      .prepare(
        `SELECT s.user_id, s.role, s.score, s.cover, s.breakdown_json, s.formula_version, s.computed_at,
                EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = s.formula_version AND q.passed = 1)
                  AS formula_published
           FROM scores s WHERE s.user_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(visibleIds),
  ]);

  const contacts = new Map<string, Contact>();
  for (const intro of contactRes.results as IntroRow[]) {
    if (contacts.has(intro.user_id)) continue;
    const c = contactFromIntro(intro);
    if (c) contacts.set(intro.user_id, c);
  }
  const scores = new Map<string, ScoreRow[]>();
  for (const s of scoreRes.results as ScoreRow[]) scores.set(s.user_id, [...(scores.get(s.user_id) ?? []), s]);

  return rows.map((r) => {
    const role: RoleKey | null = r.role && isRoleKey(r.role) ? r.role : null;
    let headline: PipelineCard["headline"] = null;
    if (r.visible === 1) {
      const roles = roleScoresOf(r.user_roles, scores.get(r.user_id) ?? []);
      // Роль картки, лише якщо людина її досі обрала; інакше найкраща порахована.
      if (roles.length) headline = headlineOf(roles, role && roles.some((x) => x.role === role) ? role : undefined);
    }
    return {
      candidate_id: r.user_id,
      label: candidateLabel(r.user_id),
      visibility: r.visible === 1 ? "visible" : "hidden",
      stage: r.stage,
      declined_by: r.declined_by,
      tags: tagsOf(r.tags),
      note_count: r.note_count,
      role,
      job_id: r.job_id,
      headline,
      contact: contacts.get(r.user_id) ?? null,
      open_intro:
        r.open_intro_id && r.open_intro_expires_at
          ? { intro_id: r.open_intro_id, expires_at: isoTime(r.open_intro_expires_at) }
          : null,
      created_at: isoTime(r.created_at),
      updated_at: isoTime(r.updated_at),
      stage_changed_at: isoTime(r.stage_changed_at),
    } satisfies PipelineCard;
  });
}

/** Контакт відкрито: прийняте знайомство або відкриття в режимі direct зі знімком контакту. */
export async function hasSharedContact(db: D1Database, companyId: string, candidateId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM intros
        WHERE company_id = ? AND user_id = ? AND status IN ('accepted', 'direct') AND contact_value IS NOT NULL
        LIMIT 1`,
    )
    .bind(companyId, candidateId)
    .first<{ ok: number }>();
  return row !== null;
}

async function assertOwnJob(db: D1Database, companyId: string, jobId: string): Promise<void> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM company_jobs WHERE id = ? AND company_id = ?")
    .bind(jobId, companyId)
    .first<{ ok: number }>();
  if (!row) throw new ActionError("not_found", 404, "This job was not found.");
}

// ---------------------------------------------------------------------------
// Актор і записи

interface EventActor {
  kind: EventActorKind;
  userId: string | null;
  keyId: string | null;
}

type CompanyCtx = ActionContext & { company: CompanyInfo };

function companyActor(ctx: ActionContext): { ctx: CompanyCtx; actor: EventActor } {
  const company = ctx.company;
  if (!company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  if (ctx.actor.kind === "member") {
    return { ctx: ctx as CompanyCtx, actor: { kind: "member", userId: ctx.actor.userId, keyId: null } };
  }
  if (ctx.actor.kind === "agent") {
    return { ctx: ctx as CompanyCtx, actor: { kind: "agent", userId: null, keyId: ctx.actor.keyId } };
  }
  throw new ActionError("forbidden", 403, "Only company members and agents can use the pipeline.");
}

const notInPipeline = () => new ActionError("not_found", 404, "This candidate is not in your pipeline.");

const conflict = () =>
  new ActionError("invalid_stage_transition", 409, "This card changed in the meantime. Reload it and try again.");

interface EventInsert {
  kind: EventKind;
  from?: Stage | null;
  to?: Stage | null;
  body?: string | null;
  meta?: Record<string, unknown> | null;
  actor: EventActor;
  at: string;
}

/** Умова «картка є (і досі на етапі `stage`)» для записів пакета. */
function cardGuard(cardId: number, stage?: Stage): { sql: string; params: (string | number)[] } {
  return stage
    ? { sql: "EXISTS (SELECT 1 FROM pipeline WHERE id = ? AND stage = ?)", params: [cardId, stage] }
    : { sql: "EXISTS (SELECT 1 FROM pipeline WHERE id = ?)", params: [cardId] };
}

/** Рядок історії, лише коли картка є (і досі на етапі `stage`). RETURNING id, created_at. */
function eventStatement(db: D1Database, cardId: number, e: EventInsert, stage?: Stage): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pipeline_events
         (pipeline_id, company_id, kind, from_stage, to_stage, body, meta_json, actor_kind, actor_user_id, actor_key_id, created_at)
       SELECT p.id, p.company_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM pipeline p WHERE p.id = ?${stage ? " AND p.stage = ?" : ""}
       RETURNING id, created_at`,
    )
    .bind(
      e.kind,
      e.from ?? null,
      e.to ?? null,
      e.body ?? null,
      e.meta ? JSON.stringify(e.meta) : null,
      e.actor.kind,
      e.actor.userId,
      e.actor.keyId,
      e.at,
      cardId,
      ...(stage ? [stage] : []),
    );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Дії

export interface AddInput {
  candidate_id: string;
  role?: RoleKey;
  job_id?: string;
  tags?: string[];
}

/**
 * Додати кандидата на етап found. Ідемпотентно: картка вже є → вона ж
 * (created = false, вхід не застосовується). Кандидат має бути видимий для
 * компанії (перевірка в самому INSERT, без проміжку між перевіркою й записом).
 */
export async function addToPipeline(rawCtx: ActionContext, input: AddInput): Promise<{ card: PipelineCard; created: boolean }> {
  const { ctx, actor } = companyActor(rawCtx);
  const company = ctx.company;
  const existing = await getCard(ctx.db, company.id, input.candidate_id);
  if (existing) return { card: existing, created: false };

  const tags = normalizeTags(input.tags ?? []);
  if (input.job_id) await assertOwnJob(ctx.db, company.id, input.job_id);

  const at = sqlTime(ctx.now);
  const v = visibleToSql(company.id);
  const eventMeta: Record<string, unknown> = {};
  if (input.role) eventMeta.role = input.role;
  if (input.job_id) eventMeta.job_id = input.job_id;
  if (tags.length) eventMeta.tags = tags;
  const auditMeta: AuditMeta = { role: input.role ?? null, job_id: input.job_id ?? null };
  const exists = {
    sql: "EXISTS (SELECT 1 FROM pipeline WHERE company_id = ? AND user_id = ?)",
    params: [company.id, input.candidate_id],
  };

  let inserted: number;
  try {
    const [insert] = await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO pipeline (company_id, user_id, stage, role, job_id, tags, added_via, added_by_user_id, added_by_key_id,
                                 stage_changed_at, created_at, updated_at)
           SELECT ?, u.id, 'found', ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM users u WHERE u.id = ? AND ${v.sql}`,
        )
        .bind(
          company.id,
          input.role ?? null,
          input.job_id ?? null,
          JSON.stringify(tags),
          ctx.channel,
          actor.userId,
          actor.keyId,
          at,
          at,
          at,
          input.candidate_id,
          ...v.params,
        ),
      ctx.db
        .prepare(
          `INSERT INTO pipeline_events (pipeline_id, company_id, kind, to_stage, meta_json, actor_kind, actor_user_id, actor_key_id, created_at)
           SELECT p.id, p.company_id, 'added', 'found', ?, ?, ?, ?, ?
             FROM pipeline p WHERE p.company_id = ? AND p.user_id = ?`,
        )
        .bind(
          Object.keys(eventMeta).length ? JSON.stringify(eventMeta) : null,
          actor.kind,
          actor.userId,
          actor.keyId,
          at,
          company.id,
          input.candidate_id,
        ),
      guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.add", target: input.candidate_id, meta: auditMeta }), exists),
    ]);
    inserted = insert.meta.changes ?? 0;
  } catch (error) {
    // Паралельне додавання тієї самої пари: пакет відкотився, картка вже є.
    if (isUniqueViolation(error)) {
      const card = await getCard(ctx.db, company.id, input.candidate_id);
      if (card) return { card, created: false };
    }
    throw error;
  }
  if (inserted !== 1) throw new ActionError("candidate_not_available", 404, "This candidate is not available.");
  const card = await getCard(ctx.db, company.id, input.candidate_id);
  if (!card) throw notInPipeline();
  return { card, created: true };
}

export interface UpdateInput {
  candidate_id: string;
  stage?: Stage;
  tags?: string[];
  job_id?: string | null;
}

/**
 * Ручна зміна картки: етап (правила 5.4), теги (замінюють список), вакансія.
 * Нічого не змінилось → жодного запису. Кожна зміна: подія + журнал.
 */
export async function updateCard(rawCtx: ActionContext, input: UpdateInput): Promise<PipelineCard> {
  const { ctx, actor } = companyActor(rawCtx);
  const company = ctx.company;
  const row = await cardBase(ctx.db, company.id, input.candidate_id);
  if (!row) throw notInPipeline();

  let stage = row.stage;
  let declinedBy = row.declined_by;
  const stageChanged = input.stage !== undefined && input.stage !== row.stage;
  if (stageChanged) {
    const to = input.stage as Stage;
    const contact = NEEDS_CONTACT.includes(to) ? await hasSharedContact(ctx.db, company.id, input.candidate_id) : false;
    const error = checkManualTransition(row.stage, to, contact);
    if (error) throw error;
    stage = to;
    declinedBy = to === "declined" ? "company" : null;
  }

  const oldTags = tagsOf(row.tags);
  const tags = input.tags !== undefined ? normalizeTags(input.tags) : oldTags;
  const tagsChanged = JSON.stringify(tags) !== JSON.stringify(oldTags);

  const jobId = input.job_id !== undefined ? input.job_id : row.job_id;
  const jobChanged = jobId !== row.job_id;
  if (jobChanged && jobId) await assertOwnJob(ctx.db, company.id, jobId);

  if (!stageChanged && !tagsChanged && !jobChanged) {
    const same = await getCard(ctx.db, company.id, input.candidate_id);
    if (!same) throw notInPipeline();
    return same;
  }

  const at = sqlTime(ctx.now);
  const guard = cardGuard(row.id, row.stage);
  const target = input.candidate_id;
  const writes: D1PreparedStatement[] = [];
  // Порядок: журнал і події (з умовою на старий етап), останнім UPDATE картки.
  if (stageChanged) {
    writes.push(
      guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.stage", target, meta: { from: row.stage, to: stage } }), guard),
      eventStatement(ctx.db, row.id, { kind: "stage_changed", from: row.stage, to: stage, actor, at }, row.stage),
    );
  }
  if (tagsChanged) {
    writes.push(
      // Текст тегів у журнал не пишемо (журнал живе довше за дані), лише кількість.
      guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.tags", target, meta: { tag_count: tags.length } }), guard),
      eventStatement(ctx.db, row.id, { kind: "tags_changed", meta: { tags }, actor, at }, row.stage),
    );
  }
  if (jobChanged) {
    writes.push(
      guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.job", target, meta: { job_id: jobId } }), guard),
      eventStatement(ctx.db, row.id, { kind: "job_linked", meta: { job_id: jobId }, actor, at }, row.stage),
    );
  }
  // Лише змінені колонки: незмінене поле не переписуємо значенням, прочитаним до пакета.
  const set: string[] = [];
  const values: (string | null)[] = [];
  if (stageChanged) {
    set.push("stage = ?", "declined_by = ?", "stage_changed_at = ?");
    values.push(stage, declinedBy, at);
  }
  if (tagsChanged) {
    set.push("tags = ?");
    values.push(JSON.stringify(tags));
  }
  if (jobChanged) {
    set.push("job_id = ?");
    values.push(jobId);
  }
  set.push("updated_at = ?");
  values.push(at);
  writes.push(
    ctx.db
      .prepare(`UPDATE pipeline SET ${set.join(", ")} WHERE id = ? AND company_id = ? AND stage = ?`)
      .bind(...values, row.id, company.id, row.stage),
  );
  const results = await ctx.db.batch(writes);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw conflict();
  const card = await getCard(ctx.db, company.id, input.candidate_id);
  if (!card) throw notInPipeline();
  return card;
}

/** Нотатка на картку: лише додавання (редагування й видалення нотаток немає). */
export async function addNote(rawCtx: ActionContext, input: { candidate_id: string; body: string }): Promise<PipelineEvent> {
  const { ctx, actor } = companyActor(rawCtx);
  const company = ctx.company;
  const body = input.body.trim();
  if (!body) {
    throw new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { body: "Write a note first." } });
  }
  const row = await cardBase(ctx.db, company.id, input.candidate_id);
  if (!row) throw notInPipeline();

  const at = sqlTime(ctx.now);
  const [inserted] = await ctx.db.batch([
    eventStatement(ctx.db, row.id, { kind: "note", body, actor, at }),
    // Текст нотатки в журнал не йде.
    guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.note", target: input.candidate_id }), cardGuard(row.id)),
    ctx.db
      .prepare("UPDATE pipeline SET note_count = note_count + 1, updated_at = ? WHERE id = ? AND company_id = ?")
      .bind(at, row.id, company.id),
  ]);
  const created = inserted.results[0] as { id: number; created_at: string } | undefined;
  if (!created) throw notInPipeline();
  return {
    id: created.id,
    kind: "note",
    from_stage: null,
    to_stage: null,
    body,
    meta: null,
    actor: { kind: actor.kind, name: ctx.actor.kind === "agent" ? ctx.actor.keyName : null },
    created_at: isoTime(created.created_at),
  };
}

/**
 * Прибрати картку: відкрите знайомство скасовується (status = 'canceled'),
 * картка й історія видаляються (каскад), журнал лишається.
 */
export async function removeFromPipeline(rawCtx: ActionContext, input: { candidate_id: string }): Promise<{ introCanceled: boolean }> {
  const { ctx } = companyActor(rawCtx);
  const company = ctx.company;
  const row = await cardBase(ctx.db, company.id, input.candidate_id);
  if (!row) throw notInPipeline();

  const at = sqlTime(ctx.now);
  const target = input.candidate_id;
  const cancelValues = auditValues(ctx, { action: "intro.cancel", target, meta: { reason: "card_removed" } });
  const results = await ctx.db.batch([
    // Рядок журналу на кожне відкрите знайомство пари (до UPDATE, поки воно pending).
    ctx.db
      .prepare(
        `INSERT INTO audit_log (actor, action, target, meta_json, at)
         SELECT ?, ?, ?, json_set(?, '$.intro_id', i.id), ?
           FROM intros i WHERE i.company_id = ? AND i.user_id = ? AND i.status = 'pending' AND ${cardGuard(row.id).sql}`,
      )
      .bind(...cancelValues, company.id, target, ...cardGuard(row.id).params),
    // Картку вже прибрав інший запит: знайомство не чіпаємо (DELETE нижче дасть 404).
    ctx.db
      .prepare(
        `UPDATE intros SET status = 'canceled', respond_token_hash = NULL, updated_at = ?
          WHERE company_id = ? AND user_id = ? AND status = 'pending' AND ${cardGuard(row.id).sql}`,
      )
      .bind(at, company.id, target, ...cardGuard(row.id).params),
    guardedAuditStatement(ctx.db, auditValues(ctx, { action: "pipeline.remove", target }), cardGuard(row.id)),
    ctx.db.prepare("DELETE FROM pipeline WHERE id = ? AND company_id = ?").bind(row.id, company.id),
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw notInPipeline();
  return { introCanceled: (results[1].meta.changes ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// Списки

const cursorError = () =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { cursor: "This cursor is not valid." } });

function encodeCursor(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
  try {
    const v = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // нижче
  }
  throw cursorError();
}

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Курсор списку: позиція (updated_at, id) останньої відданої картки.
 * Секрету в ньому немає: це власні дані компанії, а запит усе одно фільтрує company_id.
 */
function openListCursor(cursor: string): { u: string; id: number } {
  const c = decodeCursor(cursor);
  if (c.v !== 1 || typeof c.u !== "string" || !SQL_TIME.test(c.u) || !Number.isSafeInteger(c.id)) throw cursorError();
  return { u: c.u, id: c.id as number };
}

function openHistoryCursor(cursor: string): number {
  const c = decodeCursor(cursor);
  if (c.v !== 1 || c.k !== "h" || !Number.isSafeInteger(c.id) || (c.id as number) < 0) throw cursorError();
  return c.id as number;
}

/** Усі написання тегу в цій компанії (Solidity, solidity…), з якими збігається фільтр. */
async function tagSpellings(db: D1Database, companyId: string, tag: string): Promise<string[]> {
  // Кандидати звужує SQL: латиниця збігається через lower(), решту (кирилиця,
  // повноширинні літери) звіряє tagKey у TS. Межа на випадок тисяч різних тегів.
  const res = await db
    .prepare(
      `SELECT DISTINCT t.value AS tag
         FROM pipeline p, json_each(CASE WHEN json_valid(p.tags) THEN p.tags ELSE '[]' END) t
        WHERE p.company_id = ? AND t.type = 'text'
          AND (lower(trim(t.value)) = lower(trim(?)) OR t.value GLOB '*[^ -~]*')
        LIMIT ${MAX_SPELLINGS}`,
    )
    .bind(companyId, tag)
    .all<{ tag: string }>();
  const want = tagKey(tag);
  return res.results.map((r) => r.tag).filter((t) => tagKey(t) === want);
}

/** Скільки різних написань тегу розглядає фільтр (межа запиту, не продукту). */
const MAX_SPELLINGS = 500;

export interface ListInput {
  stage?: Stage;
  tag?: string;
  job_id?: string;
  cursor?: string;
  limit?: number;
}

/** Картки компанії, найсвіжіша активність першою; фільтри етапу, тегу, вакансії; counts по всій воронці. */
export async function listPipeline(rawCtx: ActionContext, input: ListInput): Promise<PipelineList> {
  const { ctx } = companyActor(rawCtx);
  const company = ctx.company;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const after = input.cursor ? openListCursor(input.cursor) : null;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (input.stage) {
    where.push("p.stage = ?");
    params.push(input.stage);
  }
  if (input.job_id) {
    where.push("p.job_id = ?");
    params.push(input.job_id);
  }
  let noMatch = false;
  if (input.tag !== undefined && input.tag.trim()) {
    const spellings = await tagSpellings(ctx.db, company.id, input.tag);
    if (spellings.length === 0) noMatch = true;
    where.push(
      `CASE WHEN json_valid(p.tags)
            THEN EXISTS (SELECT 1 FROM json_each(p.tags) t WHERE t.value IN (SELECT value FROM json_each(?)))
            ELSE 0 END`,
    );
    params.push(JSON.stringify(spellings));
  }
  if (after) {
    where.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))");
    params.push(after.u, after.u, after.id);
  }

  // Спершу лише id сторінки (індекс company_id, stage, updated_at), потім
  // видимість, знайомство й бали тільки для цих карток.
  const [countRes, pageRes] = await ctx.db.batch([
    ctx.db.prepare("SELECT stage, COUNT(*) AS n FROM pipeline WHERE company_id = ? GROUP BY stage").bind(company.id),
    ctx.db
      .prepare(
        `SELECT p.id, p.updated_at FROM pipeline p WHERE p.company_id = ?${where.map((w) => ` AND (${w})`).join("")}
          ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`,
      )
      .bind(company.id, ...params, noMatch ? 0 : limit + 1),
  ]);

  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of countRes.results as { stage: Stage; n: number }[]) counts[r.stage] = r.n;

  const found = pageRes.results as { id: number; updated_at: string }[];
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return {
    data: await cardsByIds(ctx.db, company.id, page.map((p) => p.id)),
    next_cursor: found.length > limit && last ? encodeCursor({ v: 1, u: last.updated_at, id: last.id }) : null,
    counts,
  };
}

/** Картки за id у заданому порядку (лише цієї компанії). */
async function cardsByIds(db: D1Database, companyId: string, ids: number[]): Promise<PipelineCard[]> {
  if (ids.length === 0) return [];
  const sel = cardSelect(companyId);
  const res = await db
    .prepare(`${sel.sql} AND p.id IN (SELECT value FROM json_each(?))`)
    .bind(...sel.params, JSON.stringify(ids))
    .all<CardRow>();
  const byId = new Map(res.results.map((r) => [r.id, r]));
  const rows = ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
  return projectCards(db, companyId, rows);
}

interface EventRow {
  id: number;
  kind: EventKind;
  from_stage: Stage | null;
  to_stage: Stage | null;
  body: string | null;
  meta_json: string | null;
  actor_kind: EventActorKind;
  actor_user_id: string | null;
  key_name: string | null;
  still_member: number;
  created_at: string;
}

function parseMeta(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ім'я актора для історії: назва ключа для агента; "Former member" для
 * людини, що вже не в команді (6.3). Імені людини в users немає, тож для
 * чинного члена null (інтерфейс підпише сам).
 */
function actorName(row: EventRow): string | null {
  if (row.actor_kind === "agent") return row.key_name;
  if (row.actor_kind === "member") return row.still_member ? null : "Former member";
  return null;
}

/** Історія картки, найстаріша подія першою. */
export async function listHistory(
  rawCtx: ActionContext,
  input: { candidate_id: string; cursor?: string; limit?: number },
): Promise<PipelineEventList> {
  const { ctx } = companyActor(rawCtx);
  const company = ctx.company;
  const row = await cardBase(ctx.db, company.id, input.candidate_id);
  if (!row) throw notInPipeline();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const afterId = input.cursor ? openHistoryCursor(input.cursor) : 0;

  const res = await ctx.db
    .prepare(
      `SELECT e.id, e.kind, e.from_stage, e.to_stage, e.body, e.meta_json, e.actor_kind, e.actor_user_id, e.created_at,
              k.name AS key_name,
              EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = e.company_id AND m.user_id = e.actor_user_id)
                AS still_member
         FROM pipeline_events e
         LEFT JOIN api_keys k ON k.id = e.actor_key_id AND k.company_id = e.company_id
        WHERE e.pipeline_id = ? AND e.company_id = ? AND e.id > ?
        ORDER BY e.id LIMIT ?`,
    )
    .bind(row.id, company.id, afterId, limit + 1)
    .all<EventRow>();
  const page = res.results.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map((e) => ({
      id: e.id,
      kind: e.kind,
      from_stage: e.from_stage,
      to_stage: e.to_stage,
      body: e.body,
      meta: parseMeta(e.meta_json),
      actor: { kind: e.actor_kind, name: actorName(e) },
      created_at: isoTime(e.created_at),
    })),
    next_cursor: res.results.length > limit && last ? encodeCursor({ v: 1, k: "h", id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Переходи від процесу знайомства (T5 складає їх у свій пакет)

export interface IntroTransition {
  companyId: string;
  candidateId: string;
  event: IntroEvent;
  introId: string;
  now: Date;
  /** Хто спричинив: кандидат (відповідь), член чи агент (скасування), система (прострочення). Типово система. */
  actor?: EventActor;
  /** Актор рядка журналу; типово `<company_id>:system`. */
  auditActor?: string;
}

/**
 * Інструкції для пакета знайомства: подія знайомства в історії картки,
 * рядок журналу `pipeline.stage` і зміна етапу за introStageMove. Картки
 * немає → порожньо. Усі записи з умовою на прочитаний етап: T5 має
 * перевірити, що останній запис (UPDATE картки) змінив рівно один рядок.
 */
export async function introTransitionStatements(db: D1Database, t: IntroTransition): Promise<D1PreparedStatement[]> {
  const row = await cardBase(db, t.companyId, t.candidateId);
  if (!row) return [];
  const move = introStageMove(row.stage, t.event);
  const at = sqlTime(t.now);
  const actor = t.actor ?? { kind: "system", userId: null, keyId: null };
  const guard = cardGuard(row.id, row.stage);
  const writes: D1PreparedStatement[] = [];
  if (move) {
    const meta: AuditMeta = {
      company_id: t.companyId,
      from: row.stage,
      to: move.to,
      event: t.event,
      intro_id: t.introId,
    };
    writes.push(
      guardedAuditStatement(
        db,
        [t.auditActor ?? systemAuditActor(t.companyId), "pipeline.stage", t.candidateId, JSON.stringify(meta), at],
        guard,
      ),
    );
  }
  writes.push(
    eventStatement(
      db,
      row.id,
      { kind: t.event, from: move ? row.stage : null, to: move?.to ?? null, meta: { intro_id: t.introId }, actor, at },
      row.stage,
    ),
    move
      ? db
          .prepare(
            `UPDATE pipeline SET stage = ?, declined_by = ?, stage_changed_at = ?, updated_at = ?
              WHERE id = ? AND stage = ?`,
          )
          .bind(move.to, move.declinedBy, at, at, row.id, row.stage)
      : // Етап лишається: поля етапу не чіпаємо, лише свіжа активність.
        db.prepare("UPDATE pipeline SET updated_at = ? WHERE id = ? AND stage = ?").bind(at, row.id, row.stage),
  );
  return writes;
}

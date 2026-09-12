import { OPEN_STRIPE_STATUSES } from "@/lib/billing/access";
import type { StripeApi } from "@/lib/billing/stripe";
import { normalizeX } from "@/lib/identity/normalize";
import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";
import { auditStatement, auditValues, companyAuditRange, guardedAuditStatement, type AuditEntry } from "./audit";
import { actorRole, type ActionContext, type Actor, type CompanyInfo } from "./context";
import { countryCode } from "./countries";
import { companySite, emailProvesDomain } from "./domain";
import { assertCan } from "./permissions";
import { candidateLabel } from "./project";
import { ActionError } from "./types";

/**
 * Компанія: реєстрація, налаштування, закриття, перемикач компаній, журнал дій
 * (специфікація CRM, 6.1, 10.2, 11). Команда в team.ts, заявка агенції в agency.ts.
 *
 * Права з матриці 2.2 (assertCan): налаштування змінює власник, член лише читає;
 * закрити компанію може власник (адмін через адмінку). Кожна зміна пише
 * audit_log тим самим пакетом (batch), що й сама зміна, з актором як у crm/audit.ts.
 */

/** Версія умов для компаній (docs/legal/terms-companies.md, "Version: 0.1"). */
export const COMPANY_TERMS_VERSION = "0.1";

/**
 * Куди йде людина, коли компанія готова. TODO(T7): "/company/dashboard",
 * коли з'явиться дашборд; доти перша сторінка CRM, що вже є.
 */
export const CRM_HOME = "/company/team";

/** Скільки компаній людина може створити за добу: захист від засмічення. */
export const COMPANIES_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Помилки

export type CompanyErrorCode =
  | "validation_failed"
  | "too_many_companies"
  | "not_found"
  | "last_owner"
  | "invite_invalid"
  | "invite_expired"
  | "invite_email_mismatch"
  | "email_required"
  | "seat_limit"
  | "already_member"
  | "application_not_open"
  | "rate_limited"
  | "stripe_failed";

/**
 * Помилка дій компанії й команди, яких немає в договорі REST (openapi.yaml):
 * ці дії живуть лише в інтерфейсі. Права й стан компанії кидають ActionError
 * (forbidden, company_not_active), як і реєстр дій.
 */
export class CompanyError extends Error {
  constructor(
    readonly code: CompanyErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "CompanyError";
  }
}

/** Той самий текст, що блокує видалення акаунта останнього власника (visibility.ts). */
export { LAST_OWNER_TEXT } from "./visibility";

/** Помилка, яку інтерфейс показує людині: код і текст. Решта летить далі. */
export function userFacingError(error: unknown): { code: string; message: string; fields?: Record<string, string> } | null {
  if (error instanceof CompanyError) return { code: error.code, message: error.message, fields: error.fields };
  if (error instanceof ActionError) {
    const fields = (error.details?.fields as Record<string, string> | undefined) ?? undefined;
    return { code: error.code, message: error.message, fields };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Журнал

type AuditCtx = Pick<ActionContext, "db" | "actor" | "company" | "channel" | "requestId" | "now">;

/**
 * Рядок журналу, що пишеться, лише коли `guard` (SQL-вираз з `?`) істинний у
 * мить виконання пакета: зміна не відбулась (гонка, межа місць), то й рядка немає.
 * Обгортка над guardedAuditStatement (crm/audit.ts) з контекстом дії.
 */
export function guardedAudit(
  ctx: AuditCtx,
  entry: AuditEntry,
  guard: { sql: string; params: (string | number | null)[] },
): D1PreparedStatement {
  return guardedAuditStatement(ctx.db, auditValues(ctx, entry), guard);
}

/** Контекст для дій поза реєстром: людина вже член `companyId` (або щойно стане ним). */
export function memberContext(
  db: D1Database,
  member: { userId: string; companyId: string; role: "owner" | "member" },
  company: CompanyInfo | null,
  now = new Date(),
): ActionContext {
  return {
    db,
    actor: { kind: "member", role: member.role, userId: member.userId, companyId: member.companyId },
    company,
    channel: "web",
    requestId: crypto.randomUUID(),
    now,
    env: {},
  };
}

/** Людина-член компанії з контексту або 403: дії команди й налаштувань лише для людей. */
export function memberOf(ctx: ActionContext): Extract<Actor, { kind: "member" }> & { company: CompanyInfo } {
  if (ctx.actor.kind !== "member" || !ctx.company) {
    throw new ActionError("forbidden", 403, "Sign in as a member of this company.");
  }
  return { ...ctx.actor, company: ctx.company };
}

// ---------------------------------------------------------------------------
// Поля форм

export type Fields = Record<string, string>;
type Parsed<T> = { ok: true; value: T } | { ok: false; errors: Fields };

function text(form: FormData | Fields, name: string): string {
  const v = form instanceof FormData ? form.get(name) : form[name];
  return typeof v === "string" ? v : "";
}

/** Рядок без зайвих пробілів усередині й по краях. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function companyName(raw: string, errors: Fields): string {
  const name = oneLine(raw);
  if (name.length < 2 || name.length > 80) errors.name = "Enter the company name, 2 to 80 characters.";
  return name;
}

function website(raw: string, errors: Fields, field = "website"): { website: string; domain: string } {
  const site = companySite(raw);
  if (!site.ok) {
    errors[field] = site.error.replace("your site", "your company website").replace("your website", "your company website");
    return { website: "", domain: "" };
  }
  return { website: site.website, domain: site.domain };
}

function country(raw: string, errors: Fields, field = "country"): string {
  const code = countryCode(raw);
  if (!code) errors[field] = "Choose a country.";
  return code ?? "";
}

export type CompanyKind = "company" | "agency";

export interface RegistrationInput {
  name: string;
  website: string;
  domain: string;
  country: string;
  kind: CompanyKind;
}

/** Форма /company/start (6.1). "Who are you hiring for?": own_team або agency. */
export function parseRegistration(form: FormData | Fields): Parsed<RegistrationInput> {
  const errors: Fields = {};
  const name = companyName(text(form, "name"), errors);
  const site = website(text(form, "website"), errors);
  const code = country(text(form, "country"), errors);
  const hiringFor = text(form, "hiring_for");
  if (hiringFor !== "own_team" && hiringFor !== "agency") errors.hiring_for = "Choose who you are hiring for.";
  if (text(form, "terms") !== "on") errors.terms = "Accept the Company Terms to continue.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { name, website: site.website, domain: site.domain, country: code, kind: hiringFor === "agency" ? "agency" : "company" },
  };
}

// ---------------------------------------------------------------------------
// Реєстрація (6.1, 6.2)

export interface Registered {
  companyId: string;
  kind: CompanyKind;
  status: "active" | "pending_review";
  domainVerified: boolean;
}

/**
 * Нова компанія, людина її власник, прийняті умови. "Our own team" → `active`;
 * агенція → `pending_review` (доступ після схвалення заявки адміном).
 * Домен перевірено, якщо пошта людини на домені сайту (domain.ts).
 * Одним пакетом: компанія, власник, журнал; межа COMPANIES_PER_DAY у тій самій інструкції.
 */
export async function registerCompany(
  db: D1Database,
  user: { id: string; email: string | null },
  input: RegistrationInput,
  now = new Date(),
): Promise<Registered> {
  const id = newId("co");
  const at = sqlTime(now);
  const status = input.kind === "agency" ? "pending_review" : "active";
  const verified = emailProvesDomain(user.email, input.domain);
  const owner = { userId: user.id, companyId: id, role: "owner" as const };
  const ctx = memberContext(db, owner, null, now);
  const exists = { sql: "EXISTS (SELECT 1 FROM companies WHERE id = ?)", params: [id] };

  await db.batch([
    db
      .prepare(
        `INSERT INTO companies (id, name, kind, status, website, domain, domain_verified_at, country, billing_email,
                                terms_version, terms_accepted_at, created_by, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?11, ?11
          WHERE (SELECT COUNT(*) FROM companies WHERE created_by = ?12 AND created_at > datetime(?11, '-1 day')) < ?13`,
      )
      .bind(
        id,
        input.name,
        input.kind,
        status,
        input.website,
        input.domain,
        verified ? at : null,
        input.country,
        user.email,
        COMPANY_TERMS_VERSION,
        at,
        user.id,
        COMPANIES_PER_DAY,
      ),
    db
      .prepare(
        `INSERT INTO company_members (company_id, user_id, role, joined_at, last_seen_at)
         SELECT ?1, ?2, 'owner', ?3, ?3 WHERE EXISTS (SELECT 1 FROM companies WHERE id = ?1)`,
      )
      .bind(id, user.id, at),
    guardedAudit(
      ctx,
      {
        action: "company.create",
        meta: { company_id: id, kind: input.kind, status, domain_verified: verified, terms_version: COMPANY_TERMS_VERSION },
      },
      exists,
    ),
  ]);

  const created = await db.prepare("SELECT 1 AS yes FROM companies WHERE id = ?").bind(id).first();
  if (!created) {
    throw new CompanyError(
      "too_many_companies",
      `You can create up to ${COMPANIES_PER_DAY} companies a day. Try again tomorrow or write to support@nextcryptojob.xyz.`,
    );
  }
  return { companyId: id, kind: input.kind, status, domainVerified: verified };
}

// ---------------------------------------------------------------------------
// Перемикач компаній

export interface Membership {
  companyId: string;
  name: string;
  kind: CompanyKind;
  status: CompanyInfo["status"];
  role: "owner" | "member";
}

/** Компанії людини: спершу ті, де вона була востаннє; закриті в кінці. */
export async function listMemberships(db: D1Database, userId: string): Promise<Membership[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.status, m.role
         FROM company_members m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = ?
        ORDER BY (c.status = 'closed'), m.last_seen_at IS NULL, m.last_seen_at DESC, c.name
        LIMIT 50`,
    )
    .bind(userId)
    .all<{ id: string; name: string; kind: CompanyKind; status: CompanyInfo["status"]; role: "owner" | "member" }>();
  return results.map((r) => ({ companyId: r.id, name: r.name, kind: r.kind, status: r.status, role: r.role }));
}

/**
 * Позначка «людина тут зараз»: для компанії за замовчуванням (context.ts бере
 * найсвіжішу, коли кукі немає) і колонки "Last seen" у команді.
 * Не частіше разу на годину, крім явного перемикання (`force`).
 */
export async function touchMember(db: D1Database, userId: string, companyId: string, force = false): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE company_members SET last_seen_at = datetime('now')
        WHERE company_id = ? AND user_id = ?
          AND (? = 1 OR last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour'))`,
    )
    .bind(companyId, userId, force ? 1 : 0)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Налаштування

export interface CompanyProfile {
  id: string;
  name: string;
  kind: CompanyKind;
  status: CompanyInfo["status"];
  statusReason: string | null;
  website: string | null;
  domain: string | null;
  domainVerifiedAt: string | null;
  country: string | null;
  about: string | null;
  xHandle: string | null;
  termsVersion: string;
  termsAcceptedAt: string;
  createdAt: string;
}

export async function loadCompanyProfile(db: D1Database, companyId: string): Promise<CompanyProfile | null> {
  const r = await db
    .prepare(
      `SELECT id, name, kind, status, status_reason, website, domain, domain_verified_at, country, about, x_handle,
              terms_version, terms_accepted_at, created_at
         FROM companies WHERE id = ?`,
    )
    .bind(companyId)
    .first<{
      id: string;
      name: string;
      kind: CompanyKind;
      status: CompanyInfo["status"];
      status_reason: string | null;
      website: string | null;
      domain: string | null;
      domain_verified_at: string | null;
      country: string | null;
      about: string | null;
      x_handle: string | null;
      terms_version: string;
      terms_accepted_at: string;
      created_at: string;
    }>();
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    statusReason: r.status_reason,
    website: r.website,
    domain: r.domain,
    domainVerifiedAt: r.domain_verified_at,
    country: r.country,
    about: r.about,
    xHandle: r.x_handle,
    termsVersion: r.terms_version,
    termsAcceptedAt: r.terms_accepted_at,
    createdAt: r.created_at,
  };
}

export interface SettingsInput {
  name: string;
  website: string;
  domain: string;
  country: string;
  about: string | null;
  xHandle: string | null;
}

export const ABOUT_MAX = 500;

/** Форма "Company profile" у /company/settings. */
export function parseSettings(form: FormData | Fields): Parsed<SettingsInput> {
  const errors: Fields = {};
  const name = companyName(text(form, "name"), errors);
  const site = website(text(form, "website"), errors);
  const code = country(text(form, "country"), errors);
  const about = text(form, "about").trim();
  if (about.length > ABOUT_MAX) errors.about = `Keep it under ${ABOUT_MAX} characters.`;
  let xHandle: string | null = null;
  const rawX = text(form, "x_handle").trim();
  if (rawX) {
    const x = normalizeX(rawX);
    if (x.ok) xHandle = x.value;
    else errors.x_handle = x.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, website: site.website, domain: site.domain, country: code, about: about || null, xHandle } };
}

/** Стани компанії, у яких налаштування ще можна міняти (агенція на перевірці теж). */
const EDITABLE: readonly CompanyInfo["status"][] = ["active", "pending_review"];

export function inactiveError(status: CompanyInfo["status"]): ActionError {
  const text: Record<CompanyInfo["status"], string> = {
    active: "",
    pending_review: "Your application is under review. We review applications within 2 business days.",
    suspended: "Your company account is suspended. Contact support@nextcryptojob.xyz.",
    rejected: "This company application was rejected.",
    closed: "This company account is closed.",
  };
  return new ActionError("company_not_active", 403, text[status] || "This company account is not active.");
}

/**
 * Зберегти профіль компанії (лише власник). Новий домен сайту перевіряється
 * поштою того, хто зберігає; той самий домен лишає свою перевірку.
 */
export async function updateCompanySettings(
  ctx: ActionContext,
  input: SettingsInput,
): Promise<{ changed: string[]; domainVerified: boolean }> {
  assertCan(actorRole(ctx.actor), "settings.write");
  const me = memberOf(ctx);
  const current = await loadCompanyProfile(ctx.db, me.companyId);
  if (!current) throw new CompanyError("not_found", "This company does not exist.");
  if (!EDITABLE.includes(current.status)) throw inactiveError(current.status);

  const changed: string[] = [];
  if (input.name !== current.name) changed.push("name");
  if (input.website !== current.website) changed.push("website");
  if (input.country !== current.country) changed.push("country");
  if (input.about !== current.about) changed.push("about");
  if (input.xHandle !== current.xHandle) changed.push("x_handle");

  let verifiedAt = current.domainVerifiedAt;
  if (input.domain !== current.domain) {
    const email = await ctx.db.prepare("SELECT email FROM users WHERE id = ?").bind(me.userId).first<string>("email");
    verifiedAt = emailProvesDomain(email, input.domain) ? sqlTime(ctx.now) : null;
  }
  if (changed.length === 0) return { changed, domainVerified: verifiedAt !== null };

  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE companies SET name = ?, website = ?, domain = ?, domain_verified_at = ?, country = ?, about = ?, x_handle = ?,
                              updated_at = ?
          WHERE id = ?`,
      )
      .bind(input.name, input.website, input.domain, verifiedAt, input.country, input.about, input.xHandle, sqlTime(ctx.now), me.companyId),
    auditStatement(ctx, {
      action: "company.update",
      meta: { fields: changed, domain_verified: verifiedAt !== null },
    }),
  ]);
  return { changed, domainVerified: verifiedAt !== null };
}

// ---------------------------------------------------------------------------
// Закриття (10.2, 11)

export const CLOSE_CONFIRM_WORD = "CLOSE";

/**
 * "Close company": підписку Stripe скасовано зараз, ключі API відкликано,
 * відкриті знайомства відкликано (картки назад у Found), вакансії закрито,
 * запрошення анульовано. Дані видаляються через 30 днів (у релізі 1 адмін вручну).
 * Stripe першим: якщо скасувати не вдалось, компанія лишається відкритою, щоб
 * не брати гроші з закритої компанії.
 */
export async function closeCompany(
  ctx: ActionContext,
  opts: { stripe: Pick<StripeApi, "subscriptions"> | null },
): Promise<{ canceledStripe: number }> {
  assertCan(actorRole(ctx.actor), "company.close");
  const me = memberOf(ctx);
  const companyId = me.companyId;
  const status = await ctx.db.prepare("SELECT status FROM companies WHERE id = ?").bind(companyId).first<string>("status");
  if (!status) throw new CompanyError("not_found", "This company does not exist.");
  if (status === "closed") throw inactiveError("closed");

  const placeholders = OPEN_STRIPE_STATUSES.map(() => "?").join(", ");
  const { results: open } = await ctx.db
    .prepare(
      `SELECT id, stripe_subscription_id FROM subscriptions
        WHERE company_id = ? AND provider = 'stripe' AND stripe_subscription_id IS NOT NULL AND status IN (${placeholders})`,
    )
    .bind(companyId, ...OPEN_STRIPE_STATUSES)
    .all<{ id: string; stripe_subscription_id: string }>();
  if (open.length > 0) {
    if (!opts.stripe) {
      throw new CompanyError("stripe_failed", "We could not cancel your card subscription. Write to support@nextcryptojob.xyz.");
    }
    for (const sub of open) {
      try {
        await opts.stripe.subscriptions.cancel(sub.stripe_subscription_id);
      } catch (err) {
        console.error("stripe cancel failed:", err instanceof Error ? err.message : String(err));
        throw new CompanyError("stripe_failed", "We could not cancel your card subscription. Try again in a minute.");
      }
    }
  }

  const at = sqlTime(ctx.now);
  const d = ctx.db;
  await d.batch([
    d
      .prepare(
        `UPDATE companies SET status = 'closed', status_reason = 'Closed by the owner', webhook_enabled = 0, updated_at = ?
          WHERE id = ? AND status <> 'closed'`,
      )
      .bind(at, companyId),
    d
      .prepare("UPDATE api_keys SET revoked_at = ?, revoked_by_user_id = ? WHERE company_id = ? AND revoked_at IS NULL")
      .bind(at, me.userId, companyId),
    // Історія картки до зміни знайомства: подія про відкликання для кожного відкритого.
    d
      .prepare(
        `INSERT INTO pipeline_events (pipeline_id, company_id, kind, from_stage, to_stage, meta_json, actor_kind, actor_user_id, created_at)
         SELECT p.id, p.company_id, 'intro_canceled', p.stage, CASE p.stage WHEN 'intro_requested' THEN 'found' ELSE p.stage END,
                json_object('intro_id', i.id, 'reason', 'company_closed'), 'member', ?, ?
           FROM intros i JOIN pipeline p ON p.company_id = i.company_id AND p.user_id = i.user_id
          WHERE i.company_id = ? AND i.status = 'pending'`,
      )
      .bind(me.userId, at, companyId),
    d
      .prepare(
        `UPDATE pipeline SET stage = 'found', stage_changed_at = ?, updated_at = ?
          WHERE company_id = ? AND stage = 'intro_requested'`,
      )
      .bind(at, at, companyId),
    // Токен відповіді лишається: кандидат за посиланням побачить "This request was withdrawn."
    d
      .prepare(
        `UPDATE intros SET status = 'canceled', updated_at = ?, webhook_state = 'none', webhook_next_at = NULL
          WHERE company_id = ? AND status = 'pending'`,
      )
      .bind(at, companyId),
    d
      .prepare(
        `UPDATE company_jobs SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ?,
                                 x_post_state = CASE x_post_state WHEN 'queued' THEN 'skipped' ELSE x_post_state END
          WHERE company_id = ? AND status <> 'closed'`,
      )
      .bind(at, at, companyId),
    d.prepare("DELETE FROM company_members WHERE company_id = ? AND user_id IS NULL").bind(companyId),
    d
      .prepare(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, ?), updated_at = ?
          WHERE company_id = ? AND provider = 'stripe' AND status IN (${placeholders})`,
      )
      .bind(at, at, companyId, ...OPEN_STRIPE_STATUSES),
    auditStatement(ctx, { action: "company.close", meta: { stripe_canceled: open.length } }),
  ]);
  return { canceledStripe: open.length };
}

// ---------------------------------------------------------------------------
// Підписи людей і журнал дій

export const FORMER_MEMBER = "Former member";

/**
 * Як показати людей компанії (автор нотатки, рядок журналу): поточний член →
 * пошта або Telegram-нік; той, кого прибрали або хто пішов (або видалив акаунт)
 * → "Former member" (специфікація 6.3). Особисті дані колишніх не показуємо.
 */
export async function memberLabels(db: D1Database, companyId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, string>(ids.map((id) => [id, FORMER_MEMBER]));
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.telegram_username
         FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.user_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(companyId, JSON.stringify(ids))
    .all<{ id: string; email: string | null; telegram_username: string | null }>();
  for (const r of results) out.set(r.id, personLabel(r.email, r.telegram_username));
  return out;
}

export function personLabel(email: string | null, telegram: string | null): string {
  if (email) return email;
  if (telegram) return `@${telegram.replace(/^@/, "")}`;
  return "Telegram user";
}

export interface ActivityRow {
  at: string;
  who: string;
  what: string;
}

const ACTIVITY_TEXT: Record<string, string> = {
  "company.create": "created the company",
  "company.update": "updated the company profile",
  "company.close": "closed the company",
  "agency.apply": "sent the agency application",
  "agency.resubmit": "updated the agency application",
  "team.invite": "invited a teammate",
  "team.invite_revoke": "canceled an invite",
  "team.join": "joined the team",
  "team.role": "changed a teammate's role",
  "team.remove": "removed a teammate",
  "team.leave": "left the team",
  "api_key.create": "created an API key",
  "api_key.revoke": "revoked an API key",
  "candidate.search": "searched candidates",
  "candidate.view": "viewed",
  "pipeline.add": "added to the pipeline",
  "pipeline.stage": "moved",
  "pipeline.tags": "changed tags of",
  "pipeline.note": "added a note on",
  "pipeline.remove": "removed from the pipeline",
  "intro.request": "requested an intro with",
  "intro.cancel": "withdrew the intro with",
  "contact.reveal": "viewed the Telegram handle of",
};

/**
 * Журнал дій компанії ("Activity log", 10.2): хто, що, коли. Про кандидата
 * лише мітка #3F9A1C, без інших даних. Власник і член читають (audit.read).
 */
export async function listActivity(ctx: ActionContext, limit = 50): Promise<ActivityRow[]> {
  assertCan(actorRole(ctx.actor), "audit.read");
  const me = memberOf(ctx);
  const { lo, hi } = companyAuditRange(me.companyId);
  const { results } = await ctx.db
    .prepare(
      `SELECT actor, action, target, at FROM audit_log
        WHERE actor >= ? AND actor < ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .bind(lo, hi, limit)
    .all<{ actor: string; action: string; target: string | null; at: string }>();

  const userIds: string[] = [];
  const keyIds: string[] = [];
  for (const r of results) {
    const [, kind, id] = r.actor.split(":");
    if (kind === "member" && id) userIds.push(id);
    if (kind === "agent" && id) keyIds.push(id);
  }
  const labels = await memberLabels(ctx.db, me.companyId, userIds);
  const keys = new Map<string, string>();
  if (keyIds.length > 0) {
    const { results: rows } = await ctx.db
      .prepare("SELECT id, name FROM api_keys WHERE company_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(me.companyId, JSON.stringify([...new Set(keyIds)]))
      .all<{ id: string; name: string }>();
    for (const k of rows) keys.set(k.id, k.name);
  }

  return results.map((r) => {
    const [, kind, id] = r.actor.split(":");
    const who =
      kind === "member" ? (labels.get(id) ?? FORMER_MEMBER) : kind === "agent" ? `API key ${keys.get(id) ?? "(deleted)"}` : "NextCryptoJob";
    const verb = ACTIVITY_TEXT[r.action] ?? r.action;
    const what = r.target && /^[0-9a-f-]{36}$/i.test(r.target) ? `${verb} ${candidateLabel(r.target)}` : verb;
    return { at: r.at, who, what };
  });
}

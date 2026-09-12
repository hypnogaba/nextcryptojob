import { normaliseEmail } from "@/lib/auth/email-code";
import { newId } from "@/lib/ids";
import type { Mailer } from "@/lib/mail";
import { sqlTime } from "@/lib/time";
import { CompanyError, auditIfChanged, inactiveError, memberOf, oneLine, type Fields } from "./company";
import { agencyApprovedEmail, agencyNeedsInfoEmail, agencyRejectedEmail, sendAll } from "./company-mail";
import { actorRole, type ActionContext } from "./context";
import { countryCode } from "./countries";
import { companySite } from "./domain";
import { assertCan } from "./permissions";

/**
 * Заявка агенції (специфікація CRM, 6.2). Компанія агенції народжується в
 * /company/start зі статусом `pending_review`; форма /company/apply додає рядок
 * agency_applications. Поки заявка на перевірці, CRM закрито (company_access = none,
 * реєстр дій відповідає company_not_active), відкриті лише налаштування.
 *
 * Адмін: "Approve" → заявка approved, компанія active, лист "Your agency account is approved";
 * "Ask for more info" → needs_info + reviewer_note (форма знову відкрита);
 * "Reject" → rejected + причина, компанія rejected.
 */

export type ApplicationStatus = "pending" | "needs_info" | "approved" | "rejected";

export interface ApplicationInput {
  contactName: string;
  contactEmail: string;
  website: string;
  country: string;
  clientsText: string;
  volumeText: string | null;
  dataUseText: string;
}

export const LONG_TEXT_MAX = 1000;

function text(form: FormData | Fields, name: string): string {
  const v = form instanceof FormData ? form.get(name) : form[name];
  return typeof v === "string" ? v : "";
}

/** Форма /company/apply. */
export function parseApplication(form: FormData | Fields): { ok: true; value: ApplicationInput } | { ok: false; errors: Fields } {
  const errors: Fields = {};
  const contactName = oneLine(text(form, "contact_name"));
  if (contactName.length < 2 || contactName.length > 80) errors.contact_name = "Enter your name, 2 to 80 characters.";
  const contactEmail = normaliseEmail(text(form, "contact_email"));
  if (!contactEmail) errors.contact_email = "Enter a valid work email.";
  const site = companySite(text(form, "website"));
  if (!site.ok) errors.website = site.error.replace("your site", "your agency website").replace("your website", "your agency website");
  const country = countryCode(text(form, "country"));
  if (!country) errors.country = "Choose a country.";
  const clientsText = text(form, "clients_text").trim();
  if (clientsText.length < 3 || clientsText.length > LONG_TEXT_MAX) {
    errors.clients_text = `Tell us who you recruit for, up to ${LONG_TEXT_MAX} characters.`;
  }
  const volumeText = oneLine(text(form, "volume_text"));
  if (volumeText.length > 200) errors.volume_text = "Keep it under 200 characters.";
  const dataUseText = text(form, "data_use_text").trim();
  if (dataUseText.length < 3 || dataUseText.length > LONG_TEXT_MAX) {
    errors.data_use_text = `Tell us how you will use candidate profiles, up to ${LONG_TEXT_MAX} characters.`;
  }
  if (text(form, "no_resale_ack") !== "on") {
    errors.no_resale_ack = "Confirm that you will not resell or share candidate data.";
  }
  if (Object.keys(errors).length > 0 || !contactEmail || !site.ok || !country) return { ok: false, errors };
  return {
    ok: true,
    value: { contactName, contactEmail, website: site.website, country, clientsText, volumeText: volumeText || null, dataUseText },
  };
}

export interface Application {
  id: string;
  companyId: string;
  status: ApplicationStatus;
  contactName: string;
  contactEmail: string;
  website: string;
  country: string;
  clientsText: string;
  volumeText: string | null;
  dataUseText: string;
  reviewerNote: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

type AppRow = {
  id: string;
  company_id: string;
  status: ApplicationStatus;
  contact_name: string;
  contact_email: string;
  website: string;
  country: string;
  clients_text: string;
  volume_text: string | null;
  data_use_text: string;
  reviewer_note: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
};

const APP_COLUMNS = `a.id, a.company_id, a.status, a.contact_name, a.contact_email, a.website, a.country, a.clients_text,
  a.volume_text, a.data_use_text, a.reviewer_note, a.created_at, a.updated_at, a.reviewed_at`;

function toApplication(r: AppRow): Application {
  return {
    id: r.id,
    companyId: r.company_id,
    status: r.status,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    website: r.website,
    country: r.country,
    clientsText: r.clients_text,
    volumeText: r.volume_text,
    dataUseText: r.data_use_text,
    reviewerNote: r.reviewer_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    reviewedAt: r.reviewed_at,
  };
}

/** Найновіша заявка компанії або null. */
export async function loadApplication(db: D1Database, companyId: string): Promise<Application | null> {
  const row = await db
    .prepare(`SELECT ${APP_COLUMNS} FROM agency_applications a WHERE a.company_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`)
    .bind(companyId)
    .first<AppRow>();
  return row ? toApplication(row) : null;
}

/**
 * Подати заявку або, після "Ask for more info", оновити її (знову pending).
 * Лише власник агенції, що чекає перевірки.
 */
export async function submitApplication(
  ctx: ActionContext,
  input: ApplicationInput,
): Promise<{ applicationId: string; resubmitted: boolean }> {
  assertCan(actorRole(ctx.actor), "settings.write");
  const me = memberOf(ctx);
  if (me.company.kind !== "agency") {
    throw new CompanyError("application_not_open", "Only recruiting agencies send an application.");
  }
  if (me.company.status !== "pending_review") {
    if (me.company.status === "active") throw new CompanyError("application_not_open", "Your agency account is already approved.");
    throw inactiveError(me.company.status);
  }

  const current = await loadApplication(ctx.db, me.companyId);
  const at = sqlTime(ctx.now);
  // Уже на перевірці (друге натискання, друга вкладка): та сама заявка, нічого не пишемо.
  if (current && current.status === "pending") return { applicationId: current.id, resubmitted: false };

  if (current && current.status === "needs_info") {
    const [updated] = await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE agency_applications
              SET contact_name = ?, contact_email = ?, website = ?, country = ?, clients_text = ?, volume_text = ?,
                  data_use_text = ?, no_resale_ack = 1, status = 'pending', updated_at = ?
            WHERE id = ? AND status = 'needs_info'`,
        )
        .bind(
          input.contactName,
          input.contactEmail,
          input.website,
          input.country,
          input.clientsText,
          input.volumeText,
          input.dataUseText,
          at,
          current.id,
        ),
      auditIfChanged(ctx, { action: "agency.resubmit", meta: { application_id: current.id } }),
    ]);
    // Подвійне натискання: друга відповідь бачить уже оновлену заявку і нічого не пише.
    return { applicationId: current.id, resubmitted: (updated?.meta.changes ?? 0) > 0 };
  }

  const id = newId("app");
  const [inserted] = await ctx.db.batch([
    // Друга відкрита заявка тієї самої компанії (подвійне натискання) не вставляється;
    // uq_agency_apps_open лишається страховкою.
    ctx.db
      .prepare(
        `INSERT INTO agency_applications (id, company_id, applicant_user_id, contact_name, contact_email, website, country,
                                          clients_text, volume_text, data_use_text, no_resale_ack, status, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, 'pending', ?11, ?11
          WHERE NOT EXISTS (SELECT 1 FROM agency_applications
                             WHERE company_id = ?2 AND status IN ('pending', 'needs_info'))`,
      )
      .bind(
        id,
        me.companyId,
        me.userId,
        input.contactName,
        input.contactEmail,
        input.website,
        input.country,
        input.clientsText,
        input.volumeText,
        input.dataUseText,
        at,
      ),
    auditIfChanged(ctx, { action: "agency.apply", meta: { application_id: id } }),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0) {
    const existing = await loadApplication(ctx.db, me.companyId);
    if (existing) return { applicationId: existing.id, resubmitted: false };
  }
  return { applicationId: id, resubmitted: false };
}

// ---------------------------------------------------------------------------
// Адмінка

export interface AdminApplication extends Application {
  companyName: string;
  companyStatus: string;
  domain: string | null;
  domainVerified: boolean;
  /** Пошта людини, що подала (підтверджена входом), або null. */
  applicantEmail: string | null;
}

/** Черга для /admin/agency-applications: pending і needs_info, найстаріші першими. */
export async function listApplicationsForAdmin(db: D1Database): Promise<AdminApplication[]> {
  const { results } = await db
    .prepare(
      `SELECT ${APP_COLUMNS}, c.name AS company_name, c.status AS company_status, c.domain,
              (c.domain_verified_at IS NOT NULL) AS domain_verified, u.email AS applicant_email
         FROM agency_applications a
         JOIN companies c ON c.id = a.company_id
         LEFT JOIN users u ON u.id = a.applicant_user_id
        WHERE a.status IN ('pending', 'needs_info')
        ORDER BY a.status = 'needs_info', a.updated_at, a.id
        LIMIT 200`,
    )
    .all<AppRow & { company_name: string; company_status: string; domain: string | null; domain_verified: number; applicant_email: string | null }>();
  return results.map((r) => ({
    ...toApplication(r),
    companyName: r.company_name,
    companyStatus: r.company_status,
    domain: r.domain,
    domainVerified: r.domain_verified === 1,
    applicantEmail: r.applicant_email,
  }));
}

export type ReviewDecision = "approve" | "needs_info" | "reject";

export interface ReviewInput {
  applicationId: string;
  decision: ReviewDecision;
  /** Для needs_info: що саме дописати; для reject: причина. Бачить заявник. */
  note: string;
}

export type ReviewResult =
  | { ok: true; status: ApplicationStatus; companyId: string; emailed: boolean }
  | { ok: false; reason: "not_found" | "not_open" | "not_pending" | "note_required" | "note_too_long" | "invalid_decision" };

export const REVIEW_NOTE_MAX = 1000;

/**
 * Рішення адміна. Заявка, компанія й журнал (актор `admin:<id>`) одним пакетом;
 * зміна компанії й запис журналу під умовою, що саме цей перегляд змінив заявку.
 * Лише для компанії, що чекає перевірки: закриту, призупинену чи вже вирішену
 * агенцію не схвалюємо і листа не шлемо (`not_pending`).
 * Лист лише на підтверджені пошти власників (users.email з входу кодом). Пошту
 * з форми заявки ніхто не підтверджував, тож на неї не пишемо; без пошти адмін
 * бачить, що листа не надіслано.
 */
export async function reviewApplication(
  db: D1Database,
  admin: { userId: string },
  input: ReviewInput,
  opts: { mailer: Mailer | null; origin: string; now?: Date },
): Promise<ReviewResult> {
  const now = opts.now ?? new Date();
  if (!["approve", "needs_info", "reject"].includes(input.decision)) return { ok: false, reason: "invalid_decision" };
  const note = input.note.trim();
  if (input.decision !== "approve" && note.length === 0) return { ok: false, reason: "note_required" };
  if (note.length > REVIEW_NOTE_MAX) return { ok: false, reason: "note_too_long" };

  const app = await db
    .prepare(
      `SELECT a.id, a.company_id, a.status, c.name, c.status AS company_status
         FROM agency_applications a JOIN companies c ON c.id = a.company_id WHERE a.id = ?`,
    )
    .bind(input.applicationId)
    .first<{ id: string; company_id: string; status: ApplicationStatus; name: string; company_status: string }>();
  if (!app) return { ok: false, reason: "not_found" };
  if (app.status !== "pending" && app.status !== "needs_info") return { ok: false, reason: "not_open" };
  if (app.company_status !== "pending_review") return { ok: false, reason: "not_pending" };

  const status: ApplicationStatus =
    input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "needs_info";
  const at = sqlTime(now);
  const ctx = {
    db,
    actor: { kind: "admin" as const, userId: admin.userId },
    company: null,
    channel: "web" as const,
    requestId: crypto.randomUUID(),
    now,
  };
  // Цей перегляд змінив заявку: статус, хто й коли (у межах секунди достатньо з reviewed_by).
  const mine = {
    sql: "EXISTS (SELECT 1 FROM agency_applications WHERE id = ? AND status = ? AND reviewed_by = ? AND reviewed_at = ?)",
    params: [app.id, status, admin.userId, at],
  };
  const companyUpdate =
    status === "approved"
      ? db
          .prepare(
            `UPDATE companies SET status = 'active', status_reason = NULL, updated_at = ?
              WHERE id = ? AND status = 'pending_review' AND ${mine.sql}`,
          )
          .bind(at, app.company_id, ...mine.params)
      : status === "rejected"
        ? db
            .prepare(
              `UPDATE companies SET status = 'rejected', status_reason = ?, updated_at = ?
                WHERE id = ? AND status = 'pending_review' AND ${mine.sql}`,
            )
            .bind(note, at, app.company_id, ...mine.params)
        : null;

  const [appUpdate] = await db.batch([
    db
      .prepare(
        `UPDATE agency_applications
            SET status = ?, reviewer_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'needs_info')
            AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND status = 'pending_review')`,
      )
      .bind(status, status === "approved" ? null : note, admin.userId, at, at, app.id, app.company_id),
    // Одразу за заявкою: другий паралельний перегляд нічого не змінить і рядка не допише.
    auditIfChanged(ctx, {
      action: status === "approved" ? "agency.approve" : status === "rejected" ? "agency.reject" : "agency.needs_info",
      meta: { company_id: app.company_id, application_id: app.id },
    }),
    ...(companyUpdate ? [companyUpdate] : []),
  ]);
  if ((appUpdate?.meta.changes ?? 0) === 0) {
    // Між читанням і записом: або заявку вже вирішили, або компанію закрили.
    const still = await db.prepare("SELECT status FROM companies WHERE id = ?").bind(app.company_id).first<string>("status");
    return { ok: false, reason: still === "pending_review" ? "not_open" : "not_pending" };
  }

  // Лише підтверджені пошти власників агенції.
  const { results: owners } = await db
    .prepare(
      `SELECT u.email FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.role = 'owner' AND u.email IS NOT NULL`,
    )
    .bind(app.company_id)
    .all<{ email: string }>();
  const to = owners.map((o) => o.email);
  const letter =
    status === "approved"
      ? agencyApprovedEmail({ company: app.name, link: `${opts.origin}/company/billing?welcome=1` })
      : status === "rejected"
        ? agencyRejectedEmail({ company: app.name, reason: note })
        : agencyNeedsInfoEmail({ company: app.name, note, link: `${opts.origin}/company/apply` });
  const emailed = await sendAll(opts.mailer, to, letter);
  return { ok: true, status, companyId: app.company_id, emailed };
}

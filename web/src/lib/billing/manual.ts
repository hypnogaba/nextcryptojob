import { auditStatement } from "@/lib/crm/audit";
import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";

/**
 * Ручний доступ від адміна (специфікація CRM, 8 і 12): рядок `subscriptions`
 * з `provider = 'manual'`, `status` 'trialing' або 'active', кінцем періоду й
 * причиною. Так доступ отримують журі й партнери, і так він працює, поки
 * немає ключів Stripe.
 *
 * Чинний ручний доступ у компанії один: нове надання закриває попередні
 * (status 'canceled'), тож "Grant access" також міняє строк. Відкликання
 * закриває всі чинні ручні рядки й не чіпає Stripe та USDC.
 * Кожна дія пише audit_log з актором `admin:<user id>` (crm/audit.ts).
 */

export const MANUAL_STATUSES = ["trialing", "active"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/** Найдовший ручний строк: довше це вже не "дати доступ", а забути про нього. */
export const MAX_MANUAL_DAYS = 366;
export const MAX_NOTE_LENGTH = 200;

export interface GrantInput {
  companyId: string;
  status: ManualStatus;
  /** Кінець доступу (UTC). */
  periodEnd: Date;
  note: string;
  adminUserId: string;
  now?: Date;
}

export type ManualResult =
  | { ok: true; subscriptionId?: string; closed: number }
  | { ok: false; reason: "not_found" | "invalid_status" | "invalid_period" | "note_required" | "note_too_long" };

function adminCtx(db: D1Database, adminUserId: string, now: Date) {
  return {
    db,
    actor: { kind: "admin" as const, userId: adminUserId },
    company: null,
    channel: "web" as const,
    requestId: crypto.randomUUID(),
    now,
  };
}

async function companyExists(db: D1Database, companyId: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS yes FROM companies WHERE id = ?").bind(companyId).first()) !== null;
}

const CLOSE_MANUAL = `UPDATE subscriptions SET status = 'canceled', canceled_at = ?, updated_at = ?
  WHERE company_id = ? AND provider = 'manual' AND status IN ('trialing', 'active')`;

export async function grantManualAccess(db: D1Database, input: GrantInput): Promise<ManualResult> {
  const now = input.now ?? new Date();
  if (!(MANUAL_STATUSES as readonly string[]).includes(input.status)) return { ok: false, reason: "invalid_status" };
  const end = input.periodEnd.getTime();
  if (!Number.isFinite(end) || end <= now.getTime() || end > now.getTime() + MAX_MANUAL_DAYS * 86_400_000) {
    return { ok: false, reason: "invalid_period" };
  }
  const note = input.note.trim();
  if (!note) return { ok: false, reason: "note_required" };
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, reason: "note_too_long" };
  if (!(await companyExists(db, input.companyId))) return { ok: false, reason: "not_found" };

  const id = newId("sub");
  const at = sqlTime(now);
  const periodEnd = sqlTime(input.periodEnd);
  const [closed] = await db.batch([
    db.prepare(CLOSE_MANUAL).bind(at, at, input.companyId),
    db
      .prepare(
        `INSERT INTO subscriptions (id, company_id, provider, plan, status, current_period_start, current_period_end,
                                    trial_end, granted_by, note, created_at, updated_at)
         VALUES (?, ?, 'manual', 'company_monthly', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // Ручний пробний теж пробний: після нього Stripe Checkout іде без пробного (access.ts hadTrial).
      .bind(id, input.companyId, input.status, at, periodEnd, input.status === "trialing" ? periodEnd : null,
        input.adminUserId, note, at, at),
    auditStatement(adminCtx(db, input.adminUserId, now), {
      action: "access.grant",
      // Причину в журнал не пишемо: це вільний текст, а журнал живе довше за дані.
      meta: { company_id: input.companyId, subscription_id: id, status: input.status, until: periodEnd },
    }),
  ]);
  return { ok: true, subscriptionId: id, closed: closed.meta.changes ?? 0 };
}

export async function revokeManualAccess(
  db: D1Database,
  input: { companyId: string; adminUserId: string; now?: Date },
): Promise<ManualResult> {
  const now = input.now ?? new Date();
  if (!(await companyExists(db, input.companyId))) return { ok: false, reason: "not_found" };
  const at = sqlTime(now);
  const [closed] = await db.batch([
    db.prepare(CLOSE_MANUAL).bind(at, at, input.companyId),
    auditStatement(adminCtx(db, input.adminUserId, now), {
      action: "access.revoke",
      meta: { company_id: input.companyId },
    }),
  ]);
  return { ok: true, closed: closed.meta.changes ?? 0 };
}

export interface AdminCompanyRow {
  id: string;
  name: string;
  kind: "company" | "agency";
  status: string;
  access: "subscription" | "pay_per_request" | "none";
  members: number;
  /** Найновіша підписка будь-якого провайдера. */
  provider: "stripe" | "usdc" | "manual" | null;
  subStatus: string | null;
  periodEnd: string | null;
  /** Чи є чинний ручний доступ (тоді є що відкликати). */
  manualActive: boolean;
}

/** Список для /admin/companies: найновіші 200 компаній з доступом з подання company_access. */
export async function listCompaniesForAdmin(db: D1Database): Promise<AdminCompanyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.status, a.access,
              (SELECT COUNT(*) FROM company_members m WHERE m.company_id = c.id AND m.user_id IS NOT NULL) AS members,
              s.provider, s.status AS sub_status, s.current_period_end,
              EXISTS (SELECT 1 FROM subscriptions x WHERE x.company_id = c.id AND x.provider = 'manual'
                        AND x.status IN ('trialing', 'active')) AS manual_active
         FROM companies c
         JOIN company_access a ON a.company_id = c.id
         LEFT JOIN subscriptions s ON s.id = (
           SELECT s2.id FROM subscriptions s2 WHERE s2.company_id = c.id ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)
        ORDER BY c.created_at DESC, c.id
        LIMIT 200`,
    )
    .all<{
      id: string;
      name: string;
      kind: AdminCompanyRow["kind"];
      status: string;
      access: AdminCompanyRow["access"];
      members: number;
      provider: AdminCompanyRow["provider"];
      sub_status: string | null;
      current_period_end: string | null;
      manual_active: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    access: r.access,
    members: r.members,
    provider: r.provider,
    subStatus: r.sub_status,
    periodEnd: r.current_period_end,
    manualActive: r.manual_active === 1,
  }));
}

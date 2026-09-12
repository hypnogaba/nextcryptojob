import { sqlTime } from "@/lib/time";
import type { ActionContext, Actor, Channel } from "./context";

/**
 * Журнал дій CRM у таблицю audit_log з 0002_auth.
 *
 * Специфікація (4.3) чекала колонок actor_kind, actor_id, company_id,
 * target_user_id, channel, request_id. У 0002 їх немає: там
 * `audit_log(actor, action, target, meta_json, at)` з індексами (target, at) і
 * (actor, at). Адаптер (як і дозволяє 4.3):
 * - `actor` = `<company_id>:<kind>:<id>` для людей і ключів компанії, напр.
 *   `co_…:member:<user uuid>`, `co_…:agent:key_…`; `x402_guest:<pay_… або ->`,
 *   `admin:<user uuid>`, `system`. Префікс компанії робить журнал компанії
 *   діапазоном по індексу (actor, at): `actor >= 'co_X:' AND actor < 'co_X;'`;
 * - `target` = id кандидата (users.id), якщо дія над одним кандидатом;
 * - `meta_json` = { company_id, channel, request_id, … }.
 *
 * Жодних пошт, ніків, адрес гаманців і текстів людини: журнал живе довше за
 * самі дані (0002). Тому гість x402 пишеться id платежу, а не адресою платника.
 */

export type AuditMeta = Record<string, string | number | boolean | null | string[]>;

export function auditActor(actor: Actor): string {
  switch (actor.kind) {
    case "member":
      return `${actor.companyId}:member:${actor.userId}`;
    case "agent":
      return `${actor.companyId}:agent:${actor.keyId}`;
    case "x402_guest":
      return `x402_guest:${actor.paymentId ?? "-"}`;
    case "admin":
      return `admin:${actor.userId}`;
  }
}

/**
 * Актор системних записів, що стосуються компанії (кандидат сховався, видалив
 * акаунт, знайомство прострочилось): `<company_id>:system`. Префікс компанії
 * кладе рядок у журнал компанії (companyAuditRange).
 */
export function systemAuditActor(companyId: string | null): string {
  return companyId ? `${companyId}:system` : "system";
}

/** Межі діапазону `actor` для журналу однієї компанії: WHERE actor >= lo AND actor < hi. */
export function companyAuditRange(companyId: string): { lo: string; hi: string } {
  // ';' іде в ASCII одразу за ':', тож [co_X:, co_X;) це всі рядки з префіксом co_X:.
  return { lo: `${companyId}:`, hi: `${companyId};` };
}

export interface AuditEntry {
  action: string;
  /** Кандидат (users.id), якщо дія над одним кандидатом. */
  target?: string | null;
  meta?: AuditMeta;
}

type AuditCtx = Pick<ActionContext, "db" | "actor" | "company" | "channel" | "requestId" | "now">;

/** Значення рядка журналу в порядку колонок (actor, action, target, meta_json, at). */
export function auditValues(ctx: AuditCtx, entry: AuditEntry): [string, string, string | null, string, string] {
  const meta: AuditMeta = {
    company_id: ctx.company?.id ?? null,
    channel: ctx.channel satisfies Channel,
    request_id: ctx.requestId,
    ...entry.meta,
  };
  return [auditActor(ctx.actor), entry.action, entry.target ?? null, JSON.stringify(meta), sqlTime(ctx.now)];
}

/** Інструкція для пакета (batch) разом з рештою записів дії. */
export function auditStatement(ctx: AuditCtx, entry: AuditEntry): D1PreparedStatement {
  return ctx.db
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, ?, ?, ?, ?)")
    .bind(...auditValues(ctx, entry));
}

/**
 * Рядок журналу, що пишеться, лише коли умова `guard` (SQL-вираз з `?`) істинна
 * в мить виконання. Так запис журналу в пакеті йде разом з ефектом: змінилась
 * картка між читанням і пакетом, тоді немає ні ефекту, ні рядка журналу.
 */
export function guardedAuditStatement(
  db: D1Database,
  values: [string, string, string | null, string, string],
  guard: { sql: string; params: (string | number | null)[] },
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (actor, action, target, meta_json, at) SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`)
    .bind(...values, ...guard.params);
}

export async function writeAudit(
  ctx: Pick<ActionContext, "db" | "actor" | "company" | "channel" | "requestId" | "now">,
  entry: AuditEntry,
): Promise<void> {
  await auditStatement(ctx, entry).run();
}

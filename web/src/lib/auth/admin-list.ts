/**
 * Хто адмін за поштою: секрет Worker `ADMIN_EMAILS` (пошти через кому, без розрізнення регістру).
 * Не задано або порожньо = адмінів немає: жодна сторінка /admin не відкриється і сповіщення нікуди
 * не підуть. Так навмисно: репозиторій публічний, і чиясь особиста пошта не має лежати в коді як
 * «адмін за замовчуванням». Без залежностей: це читає й cron у точці входу Worker (сповіщення,
 * lib/admin/alerts.ts). Правило сесії (лише вхід поштою) у ./admin.ts.
 */

export const DEFAULT_ADMIN_EMAILS: readonly string[] = [];

export function adminEmails(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
  return list.length > 0 ? list : [...DEFAULT_ADMIN_EMAILS];
}

export function isAdminEmail(email: string | null | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  return adminEmails(raw).includes(email.trim().toLowerCase());
}

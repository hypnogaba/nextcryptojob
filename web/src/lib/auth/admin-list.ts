/**
 * Хто адмін за поштою: змінна Worker `ADMIN_EMAILS` (пошти через кому, без розрізнення
 * регістру); не задано або порожньо = лише власник продукту. Без залежностей: це читає й
 * cron у точці входу Worker (сповіщення власнику, lib/admin/alerts.ts). Правило сесії
 * (вхід поштою) у ./admin.ts.
 */

export const DEFAULT_ADMIN_EMAILS: readonly string[] = ["hypnogaba@gmail.com"];

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

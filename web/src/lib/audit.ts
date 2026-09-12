import { db } from "@/lib/db";

/**
 * Запис у журнал дій (таблиця audit_log з 0002_auth).
 *
 * meta не містить персональних даних, окрім ідентифікаторів: жодних пошт,
 * ніків, адрес гаманців чи текстів людини. Журнал живе довше за самі дані.
 */
export async function audit(
  actor: string | null,
  action: string,
  target: string | null,
  meta?: Record<string, string | number | boolean | null>,
): Promise<void> {
  await db()
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, ?, ?, ?)")
    .bind(actor, action, target, meta ? JSON.stringify(meta) : null)
    .run();
}

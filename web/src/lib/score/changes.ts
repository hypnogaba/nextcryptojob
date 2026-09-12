// Мітка «джерела чи ролі змінились» для правила «не губити перерахунок»
// (рев'ю W4, I4). Пишемо в audit_log: там уже є індекс (actor, at), а видалення
// гаманця чи зміна ролей іншого сліду в базі не лишають. Без персональних даних.

export type ChangeKind = "roles" | "x" | "github" | "wallets" | "sources" | "verify";

export async function markSourcesChanged(db: D1Database, userId: string, what: ChangeKind): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, 'sources.change', ?, ?)")
    .bind(userId, userId, JSON.stringify({ what }))
    .run();
}

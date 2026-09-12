// Чи дивиться на картку її власник. Лише так/ні: сторінка картки не знає й не
// показує, чий це акаунт, а кнопку «Share on X» бачить тільки власник.
import { isSlug } from "./slug";

export async function isCardOwner(db: D1Database, slug: string, viewerId: string | null): Promise<boolean> {
  // Без сесії або з хибним slug навіть не питаємо базу.
  if (!viewerId || !isSlug(slug)) return false;
  const row = await db
    .prepare("SELECT 1 AS owner FROM cards WHERE slug = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(slug, viewerId)
    .first<{ owner: number }>();
  return row !== null;
}

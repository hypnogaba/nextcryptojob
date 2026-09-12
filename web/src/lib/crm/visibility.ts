/**
 * Правило видимості кандидата (специфікація CRM, 3.4): один SQL-фрагмент на
 * всі запити, перевірка наживо в кожному запиті, без кеша профілів.
 *
 * Людина видима, лише коли водночас:
 * - `users.visible_to_companies = 1`;
 * - є чинна згода `visibility`. У 0002 згода це поточний стан рядка
 *   `consents(user_id, kind, granted, …)`: чинна = `granted = 1` (колонки
 *   `revoked_at`, як у специфікації 3.4, у міграції немає).
 * Для запитів компанії ще:
 * - кандидат не заблокував компанію («Decline and block»: intros.candidate_blocked = 1).
 *   Блок виглядає як невидимість, без підказки, що саме блок;
 * - кандидат не член команди цієї компанії (не бачить себе в пошуку своєї компанії).
 *
 * Фрагменти мають позиційні `?`; параметри повертаються в тому ж порядку.
 */

export interface SqlFragment {
  sql: string;
  params: (string | number | null)[];
}

/** Базова видимість (гість x402 і будь-яка компанія). `u` = псевдонім таблиці users. */
export function visibleSql(u = "u"): SqlFragment {
  return {
    sql: `${u}.visible_to_companies = 1
      AND EXISTS (SELECT 1 FROM consents vc
                   WHERE vc.user_id = ${u}.id AND vc.kind = 'visibility' AND vc.granted = 1)`,
    params: [],
  };
}

/** Видимість для конкретної компанії (або базова, якщо компанії немає). */
export function visibleToSql(companyId: string | null, u = "u"): SqlFragment {
  const base = visibleSql(u);
  if (!companyId) return base;
  return {
    sql: `${base.sql}
      AND NOT EXISTS (SELECT 1 FROM intros vb
                       WHERE vb.company_id = ? AND vb.user_id = ${u}.id AND vb.candidate_blocked = 1)
      AND NOT EXISTS (SELECT 1 FROM company_members vm
                       WHERE vm.company_id = ? AND vm.user_id = ${u}.id)`,
    params: [companyId, companyId],
  };
}

/**
 * Бал показуємо лише для версії формули, що пройшла ворота якості (spec §6.3).
 * `s` = псевдонім таблиці scores. Інакше роль непорахована з причиною not_published.
 */
export function publishedSql(s = "s"): string {
  return `(${s}.score IS NOT NULL
      AND EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = ${s}.formula_version AND q.passed = 1))`;
}

/** Чи кандидат видимий для компанії (або для гостя, якщо companyId = null). */
export async function isVisibleTo(db: D1Database, userId: string, companyId: string | null): Promise<boolean> {
  const v = visibleToSql(companyId);
  const row = await db
    .prepare(`SELECT 1 AS ok FROM users u WHERE u.id = ? AND ${v.sql}`)
    .bind(userId, ...v.params)
    .first<{ ok: number }>();
  return row !== null;
}

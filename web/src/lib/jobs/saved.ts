// Збережені вакансії (раунд 5, п.16): кнопка «Save» на картці, вкладка Saved на /jobs.
// job_ref у форматі sent.job_ref: 'nr:<id>' (зі сканування) або 'co:<id>' (компанії),
// web/src/lib/jobs/instant.ts digestJobOf. Таблиця saved_jobs, міграція 0024.

const REF = /^(nr|co):[A-Za-z0-9_-]+$/;

/** Чи схожий рядок на job_ref: захист від сміття у формі, не перевірка існування вакансії. */
export function isJobRef(value: unknown): value is string {
  return typeof value === "string" && REF.test(value);
}

export async function listSavedRefs(d: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await d.prepare("SELECT job_ref FROM saved_jobs WHERE user_id = ?").bind(userId).all<{ job_ref: string }>();
  return new Set(results.map((r) => r.job_ref));
}

export async function saveJob(d: D1Database, userId: string, ref: string): Promise<void> {
  if (!isJobRef(ref)) return;
  await d.prepare("INSERT OR IGNORE INTO saved_jobs (user_id, job_ref) VALUES (?, ?)").bind(userId, ref).run();
}

export async function unsaveJob(d: D1Database, userId: string, ref: string): Promise<void> {
  await d.prepare("DELETE FROM saved_jobs WHERE user_id = ? AND job_ref = ?").bind(userId, ref).run();
}

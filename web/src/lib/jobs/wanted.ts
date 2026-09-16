// Вакансія, заради якої людина прийшла (раунд 6, власник 16.09: «коли хочемо натиснути на
// конкретну роботу, треба щоб нас кидало на створення профілю, і в профілі їх показувало»).
// Рядок живої стрічки на головній веде на /start?job=<ref>, а не одразу на чужий сайт: ми
// запам'ятовуємо вакансію в куці й кладемо її в saved_jobs, щойно з'явилась сесія
// (lib/auth/session.ts createSession). Людина бачить її в кабінеті, вкладка Saved на /jobs.

import { saveJob } from "./saved";

export const WANTED_JOB_COOKIE = "ncj_job";
/** Тиждень: людина може створити профіль не того самого дня, коли натиснула вакансію. */
export const WANTED_JOB_MAX_AGE = 7 * 24 * 3600;

/** Переносить вакансію з куки в збережені цієї людини. Мовчить, якщо куки немає чи вона зіпсована. */
export async function takeWantedJob(d: D1Database, userId: string, ref: string | undefined): Promise<void> {
  if (!ref) return;
  try {
    await saveJob(d, userId, ref);
  } catch (e) {
    // Не привід валити вхід: людина просто не побачить цю вакансію збереженою.
    console.warn("wanted job not saved:", e instanceof Error ? e.name : "unknown");
  }
}

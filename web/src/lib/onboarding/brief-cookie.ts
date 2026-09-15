// Бриф з головної до анкети: форма «What work are you looking for?» (GET /start) кладе
// текст у куку, перший крок /welcome бере його як чернетку, поки людина не зберегла свій.

export const BRIEF_COOKIE = "ncj_brief";
/**
 * Стільки символів несемо. Кука міряється байтами: у encodeURIComponent кирилиця дає
 * 6 байтів на літеру, тож 400 символів лишаються під межею 4 КБ.
 */
export const BRIEF_MAX_CHARS = 400;

/** Текст з форми: пробіли зведено, обрізано до BRIEF_MAX_CHARS. */
export function cleanBrief(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_MAX_CHARS);
}

/** Значення куки назад у текст; зіпсоване значення дає порожній рядок. */
export function readBriefCookie(value: string | undefined): string {
  if (!value) return "";
  try {
    return cleanBrief(decodeURIComponent(value));
  } catch {
    return "";
  }
}

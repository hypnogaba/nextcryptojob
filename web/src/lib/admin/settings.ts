import { sqlTime } from "@/lib/time";

/**
 * Налаштування, які адмін міняє на /admin/settings без деплою (таблиця app_settings, 0019).
 *
 * Лише те, що web виконує одразу й безпечно: відкрити чи закрити нові реєстрації і
 * повідомлення на весь сайт. Квоти, місця й пробний строк лишаються в коді (lib/crm/quotas.ts,
 * lib/billing/checkout.ts): їх читають синхронно в багатьох місцях, і ті самі числа стоять у
 * текстах сторінок та умовах для компаній, тож адмінка показує їх лише для читання.
 *
 * Реєстр типований: кожен ключ має значення за замовчуванням і перевірку. Рядка в базі
 * немає, значення криве або ключ невідомий: беремо значення за замовчуванням. Таблиці ще
 * немає (0019 не накочено) або база не відповіла: теж за замовчуванням, тобто реєстрації
 * відкриті, а повідомлення немає. Налаштування не має закрити вхід через збій читання.
 *
 * Кеш на ізолят Worker на SETTINGS_CACHE_TTL_MS: вхід і /api/me читають налаштування
 * часто, а міняються вони рідко. Зміна з адмінки скидає кеш свого ізоляту одразу, інші
 * ізоляти побачать її не пізніше ніж за хвилину. Кожна зміна пише audit_log.
 */

export const SETTINGS_CACHE_TTL_MS = 60_000;
export const BANNER_MAX_LENGTH = 200;
export const BANNER_LEVELS = ["info", "warning"] as const;
export type BannerLevel = (typeof BANNER_LEVELS)[number];

export type AppSettings = {
  /** Нові кандидати можуть створити акаунт (вхід поштою чи Telegram). */
  signups_open: boolean;
  /** Нові компанії й агенції можуть зареєструватись на /company/start. */
  company_signups_open: boolean;
  /** Повідомлення вгорі кожної сторінки, простий текст. Порожнє = немає. */
  banner_message: string;
  banner_level: BannerLevel;
};

export type SettingKey = keyof AppSettings;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type SettingDef<K extends SettingKey> = {
  key: K;
  kind: "boolean" | "text" | "choice";
  label: string;
  help: string;
  default: AppSettings[K];
  options?: readonly string[];
  maxLength?: number;
  /** Значення з форми (рядок) або з бази (JSON) у тип ключа, або помилка для людини. */
  parse: (raw: unknown) => Parsed<AppSettings[K]>;
};

function parseBoolean(raw: unknown): Parsed<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (raw === 1 || raw === "1" || raw === "true" || raw === "on") return { ok: true, value: true };
  if (raw === 0 || raw === "0" || raw === "false" || raw === "off" || raw === "") return { ok: true, value: false };
  return { ok: false, error: "Choose on or off." };
}

/**
 * Текст повідомлення: один рядок, без керівних символів, пробіли зведені. Показуємо як
 * текст (React екранує), розмітки й посилань немає. Довге тире замінюємо звичайним
 * дефісом: правило продукту для всіх текстів сайту.
 */
function parseBanner(raw: unknown): Parsed<string> {
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: "The notice must be text." };
  const value = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > BANNER_MAX_LENGTH) {
    return { ok: false, error: `Keep the notice under ${BANNER_MAX_LENGTH} characters (now ${value.length}).` };
  }
  return { ok: true, value };
}

function parseLevel(raw: unknown): Parsed<BannerLevel> {
  return typeof raw === "string" && (BANNER_LEVELS as readonly string[]).includes(raw)
    ? { ok: true, value: raw as BannerLevel }
    : { ok: false, error: "Choose Info or Warning." };
}

export const SETTINGS: { [K in SettingKey]: SettingDef<K> } = {
  signups_open: {
    key: "signups_open",
    kind: "boolean",
    label: "Candidate sign-ups open",
    help: "Off: new people cannot create an account by email or Telegram and see a closed-for-now message. Existing accounts sign in as usual.",
    default: true,
    parse: parseBoolean,
  },
  company_signups_open: {
    key: "company_signups_open",
    kind: "boolean",
    label: "Company sign-ups open",
    help: "Off: nobody can create a new company or agency account. Existing companies, their teams and invites keep working.",
    default: true,
    parse: parseBoolean,
  },
  banner_message: {
    key: "banner_message",
    kind: "text",
    label: "Site notice",
    help: `Plain text shown at the top of every page, up to ${BANNER_MAX_LENGTH} characters. Empty hides it.`,
    default: "",
    maxLength: BANNER_MAX_LENGTH,
    parse: parseBanner,
  },
  banner_level: {
    key: "banner_level",
    kind: "choice",
    label: "Notice style",
    help: "Info is neutral. Warning uses the accent color, for outages and delays.",
    default: "info",
    options: BANNER_LEVELS,
    parse: parseLevel,
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export const DEFAULT_SETTINGS: AppSettings = Object.fromEntries(
  SETTING_KEYS.map((k) => [k, SETTINGS[k].default]),
) as AppSettings;

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && Object.hasOwn(SETTINGS, value);
}

/** Коли і ким змінено ключ (для сторінки налаштувань). */
export type SettingMeta = { updatedAt: string; updatedBy: string | null };

export type LoadedSettings = {
  values: AppSettings;
  meta: Partial<Record<SettingKey, SettingMeta>>;
  /** Причина, чому взято значення за замовчуванням (таблиці немає, база не відповіла). */
  error: string | null;
};

type Row = { key: string; value_json: string; updated_at: string; updated_by: string | null };

/** Налаштування з бази без кешу: для сторінки налаштувань і для запису. */
export async function loadSettings(db: D1Database): Promise<LoadedSettings> {
  const values: AppSettings = { ...DEFAULT_SETTINGS };
  const meta: LoadedSettings["meta"] = {};
  let rows: Row[];
  try {
    rows = (await db.prepare("SELECT key, value_json, updated_at, updated_by FROM app_settings").all<Row>()).results;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`settings: using defaults, could not read app_settings: ${error}`);
    return { values, meta, error };
  }
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.value_json);
    } catch {
      console.warn(`settings: ${row.key} is not valid JSON, using the default`);
      continue;
    }
    const parsed = SETTINGS[row.key].parse(raw);
    if (!parsed.ok) {
      console.warn(`settings: ${row.key} has a bad value, using the default`);
      continue;
    }
    (values as Record<SettingKey, unknown>)[row.key] = parsed.value;
    meta[row.key] = { updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  return { values, meta, error: null };
}

/**
 * Кеш модуля на ізолят. Помилку читання теж кешуємо (значення за замовчуванням) на той
 * самий строк: без таблиці кожен вхід не має бити в базу знову. Незавершений запит між
 * запитами не ділимо (у Workers проміс, що чекає на I/O іншого запиту, може зависнути).
 */
let cached: { at: number; values: AppSettings } | null = null;

/** Чинні налаштування (кеш 60 с). */
export async function getSettings(db: D1Database, now: number = Date.now()): Promise<AppSettings> {
  if (cached && now - cached.at >= 0 && now - cached.at < SETTINGS_CACHE_TTL_MS) return cached.values;
  const { values } = await loadSettings(db);
  cached = { at: now, values };
  return values;
}

/** Забути кеш: після зміни з адмінки і в тестах. */
export function resetSettingsCache(): void {
  cached = null;
}

/** Повідомлення на весь сайт або null. */
export function siteNotice(s: AppSettings): { message: string; level: BannerLevel } | null {
  return s.banner_message ? { message: s.banner_message, level: s.banner_level } : null;
}

export type UpdateResult =
  | { ok: true; changed: SettingKey[] }
  | { ok: false; errors: Partial<Record<SettingKey, string>> }
  | { ok: false; unavailable: string };

/**
 * Записати значення з форми. Перевіряє всі ключі до запису; пише лише змінені, кожен
 * з рядком audit_log (`admin:<id>`, `settings.update`, target `setting:<ключ>`) в одному
 * пакеті. У журналі старе й нове значення: це тексти адміна, а не дані людей.
 */
export async function updateSettings(
  db: D1Database,
  input: { adminUserId: string; values: Partial<Record<SettingKey, unknown>>; now?: Date },
): Promise<UpdateResult> {
  const next: Partial<AppSettings> = {};
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const [key, raw] of Object.entries(input.values)) {
    if (!isSettingKey(key)) continue;
    const parsed = SETTINGS[key].parse(raw);
    if (parsed.ok) (next as Record<SettingKey, unknown>)[key] = parsed.value;
    else errors[key] = parsed.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const current = await loadSettings(db);
  if (current.error) return { ok: false, unavailable: current.error };
  const changed = (Object.keys(next) as SettingKey[]).filter((k) => next[k] !== current.values[k]);
  if (changed.length === 0) return { ok: true, changed };

  const at = sqlTime(input.now ?? new Date());
  const actor = `admin:${input.adminUserId}`;
  await db.batch(
    changed.flatMap((key) => [
      db
        .prepare(
          `INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at,
                                          updated_by = excluded.updated_by`,
        )
        .bind(key, JSON.stringify(next[key]), at, input.adminUserId),
      db
        .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, 'settings.update', ?, ?, ?)")
        .bind(actor, `setting:${key}`, JSON.stringify({ key, from: current.values[key], to: next[key] }), at),
    ]),
  );
  resetSettingsCache();
  return { ok: true, changed };
}

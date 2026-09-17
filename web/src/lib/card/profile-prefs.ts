// Налаштування профілю-доказу (таблиця profile_prefs, 0026) і особистий ключ для подачі.
// Ключ не зберігається: він виводиться з SESSION_SECRET, id власника і версії, тож перевірка
// лише повторює вивід. «Reset apply link» підіймає версію, і старе посилання перестає діяти.
import { hmacSha256Hex, safeEqual } from "@/lib/auth/hash";
import { isPublicHostname } from "@/lib/identity/normalize";

/** Посилань на роботи: v7 рахує до 10 (engine LINKS_TOP). */
export const LINKS_MAX = 10;
export const LINK_LABEL_MAX = 40;
export const LINK_URL_MAX = 300;
const HIDDEN_MAX = 64;
const KEY_LENGTH = 32;
const ITEM_ID = /^[a-z_]+\.[a-zA-Z0-9]+$/;

export type ProfileLink = { label: string; url: string };

export type ProfilePrefs = {
  keyVersion: number;
  hidden: string[];
  links: ProfileLink[];
  showWallet: boolean;
};

export const DEFAULT_PREFS: ProfilePrefs = { keyVersion: 0, hidden: [], links: [], showWallet: false };

type Row = { key_version: number; hidden_json: string; links_json: string; show_wallet: number };

function parseList(json: string): unknown[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toPrefs(row: Row | null): ProfilePrefs {
  if (!row) return { ...DEFAULT_PREFS };
  return {
    keyVersion: row.key_version,
    hidden: parseList(row.hidden_json).filter((v): v is string => typeof v === "string" && ITEM_ID.test(v)),
    links: parseList(row.links_json).flatMap((v) => {
      const l = v as Partial<ProfileLink> | null;
      return l && typeof l.label === "string" && typeof l.url === "string" ? [{ label: l.label, url: l.url }] : [];
    }),
    showWallet: row.show_wallet === 1,
  };
}

export async function loadPrefs(db: D1Database, userId: string): Promise<ProfilePrefs> {
  const row = await db
    .prepare("SELECT key_version, hidden_json, links_json, show_wallet FROM profile_prefs WHERE user_id = ?")
    .bind(userId)
    .first<Row>();
  return toPrefs(row);
}

/** Один UPSERT на поле: решта налаштувань лишається як є. */
async function upsert(db: D1Database, userId: string, column: string, value: string | number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profile_prefs (user_id, ${column}) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = datetime('now')`,
    )
    .bind(userId, value)
    .run();
}

export function isItemId(v: string): boolean {
  return ITEM_ID.test(v);
}

export async function setHidden(db: D1Database, userId: string, itemId: string, hidden: boolean): Promise<boolean> {
  if (!isItemId(itemId)) return false;
  const cur = new Set((await loadPrefs(db, userId)).hidden);
  if (hidden) cur.add(itemId);
  else cur.delete(itemId);
  if (cur.size > HIDDEN_MAX) return false;
  await upsert(db, userId, "hidden_json", JSON.stringify([...cur].sort()));
  return true;
}

export async function setShowWallet(db: D1Database, userId: string, on: boolean): Promise<void> {
  await upsert(db, userId, "show_wallet", on ? 1 : 0);
}

export type LinkResult = { ok: true; link: ProfileLink } | { ok: false; error: string };

/**
 * Посилання людини: лише https і публічне ім'я хоста. Наш сервер за ним не ходить, лише
 * показує, тож запит і якір лишаються (відео, документ).
 */
export function normalizeLink(labelInput: string, urlInput: string): LinkResult {
  const label = labelInput.trim().replace(/\s+/g, " ");
  if (!label) return { ok: false, error: "Give the link a short name." };
  if ([...label].length > LINK_LABEL_MAX) return { ok: false, error: `Keep the name under ${LINK_LABEL_MAX} characters.` };
  const raw = urlInput.trim();
  if (!/^https:\/\//i.test(raw)) return { ok: false, error: "Use an https:// address." };
  if (raw.length > LINK_URL_MAX) return { ok: false, error: "This address is too long." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "This does not look like a web address." };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.username || url.password || url.port || !isPublicHostname(host)) {
    return { ok: false, error: "This does not look like a public web address." };
  }
  return { ok: true, link: { label, url: `https://${host}${url.pathname}${url.search}${url.hash}` } };
}

export async function addLink(db: D1Database, userId: string, label: string, url: string): Promise<LinkResult> {
  const res = normalizeLink(label, url);
  if (!res.ok) return res;
  const links = (await loadPrefs(db, userId)).links;
  if (links.length >= LINKS_MAX) return { ok: false, error: `You can add up to ${LINKS_MAX} links.` };
  await upsert(db, userId, "links_json", JSON.stringify([...links, res.link]));
  return res;
}

export async function removeLink(db: D1Database, userId: string, index: number): Promise<void> {
  const links = (await loadPrefs(db, userId)).links;
  if (!Number.isInteger(index) || index < 0 || index >= links.length) return;
  links.splice(index, 1);
  await upsert(db, userId, "links_json", JSON.stringify(links));
}

export async function profileKey(secret: string, userId: string, version: number): Promise<string> {
  return (await hmacSha256Hex(secret, `profile-key:${userId}:${version}`)).slice(0, KEY_LENGTH);
}

/** Версія ключа, створена за потреби (перше «Copy apply link»). */
export async function ensureKeyVersion(db: D1Database, userId: string): Promise<number> {
  await db
    .prepare(
      `INSERT INTO profile_prefs (user_id, key_version) VALUES (?, 1)
       ON CONFLICT(user_id) DO UPDATE SET key_version = MAX(key_version, 1)`,
    )
    .bind(userId)
    .run();
  return (await loadPrefs(db, userId)).keyVersion;
}

export async function resetKey(db: D1Database, userId: string): Promise<number> {
  await db
    .prepare(
      `INSERT INTO profile_prefs (user_id, key_version) VALUES (?, 2)
       ON CONFLICT(user_id) DO UPDATE SET key_version = key_version + 1, updated_at = datetime('now')`,
    )
    .bind(userId)
    .run();
  return (await loadPrefs(db, userId)).keyVersion;
}

/** Чи відмикає ключ повний вигляд картки: лише ключ власника цієї картки й поточної версії. */
export function keyMatches(expected: string | null, given: string | null | undefined): boolean {
  if (!expected || typeof given !== "string" || given.length !== KEY_LENGTH) return false;
  return safeEqual(expected, given);
}

// Реєстр дошок екосистем і фондів (таблиця job_boards, db/jobs/0003_job_boards.sql). Джерело правди:
// db/jobs/seed/boards.json (перевірено сторінкою кожної дошки 14.09.2026). Дошка Getro з рішенням
// 'discover' раз на тиждень дає розвідці (discover.ts) роботодавців і адреси їхніх ATS; вакансії далі
// йдуть лише з API ATS. Consider і решту не читаємо: див. `reason` кожного рядка.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BOARD_KINDS = ["ecosystem", "fund", "association"] as const;
export const BOARD_PLATFORMS = ["getro", "consider", "pallet", "custom", "ats", "none"] as const;
export const BOARD_DECISIONS = ["discover", "skip", "manual"] as const;

export type BoardKind = (typeof BOARD_KINDS)[number];
export type BoardPlatform = (typeof BOARD_PLATFORMS)[number];
/** discover: щотижнева розвідка; manual: роботодавців додано руками з публічного портфеля; skip: ні. */
export type BoardDecision = (typeof BOARD_DECISIONS)[number];
/**
 * all: кожна організація дошки крипто (екосистема, крипто-фонд); tagged: та, кого Getro називає крипто
 * або ніяк (фонд, що інвестує й поза криптою); strict: лише названа крипто (фонд, де крипто меншість).
 */
export type CryptoScope = "all" | "tagged" | "strict";
const SCOPES: readonly CryptoScope[] = ["all", "tagged", "strict"];

export interface SeedJobBoard {
  slug: string;
  label: string;
  kind: BoardKind;
  /** Адреса дошки (або сторінки портфеля для 'manual', або null, якщо дошки немає). */
  url: string | null;
  platform: BoardPlatform;
  /** Getro: номер колекції (`network.id` сторінки); ATS: `<провайдер>:<слаг>`; інакше null. */
  platform_id: string | null;
  /** Скільки компаній показує дошка (на день перевірки), якщо видно. */
  companies: number | null;
  decision: BoardDecision;
  crypto_scope: CryptoScope;
  /** Чому таке рішення: одним рядком, англійською, як terms_note у sources. */
  reason: string;
  checked_at: string;
}

export interface BoardRegistry {
  version: 1;
  /** Звідки й коли: лише опис. */
  source: string;
  boards: SeedJobBoard[];
}

/** Дошка Getro для розвідки. */
export interface GetroBoard {
  slug: string;
  label: string;
  collectionId: number;
  /** Хост дошки: вакансія з адресою на ньому живе лише на Getro. */
  host: string | null;
  cryptoScope: CryptoScope;
}

export const BOARDS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/jobs/seed/boards.json");

const includes = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Помилки форми; порожньо = годиться. */
export function boardProblems(reg: BoardRegistry): string[] {
  const out: string[] = [];
  const allowed = new Set(["slug", "label", "kind", "url", "platform", "platform_id", "companies", "decision", "crypto_scope", "reason", "checked_at"]);
  const slugs = new Set<string>();
  const getroIds = new Set<string>();
  for (const b of reg.boards) {
    for (const k of Object.keys(b)) if (!allowed.has(k)) out.push(`boards.${b.slug}: зайве поле ${k}`);
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(b.slug) || slugs.has(b.slug)) out.push(`boards: повтор або дивний slug ${b.slug}`);
    slugs.add(b.slug);
    if (!b.label?.trim()) out.push(`boards.${b.slug}: без назви`);
    if (!includes(BOARD_KINDS, b.kind)) out.push(`boards.${b.slug}: невідомий kind ${String(b.kind)}`);
    if (!includes(BOARD_PLATFORMS, b.platform)) out.push(`boards.${b.slug}: невідома платформа ${String(b.platform)}`);
    if (!includes(BOARD_DECISIONS, b.decision)) out.push(`boards.${b.slug}: невідоме рішення ${String(b.decision)}`);
    if (!SCOPES.includes(b.crypto_scope)) out.push(`boards.${b.slug}: crypto_scope має бути all, tagged або strict`);
    if (b.url !== null && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(b.url)) out.push(`boards.${b.slug}: адреса не https`);
    if (!b.reason?.trim()) out.push(`boards.${b.slug}: без причини рішення`);
    if (b.companies !== null && (!Number.isInteger(b.companies) || b.companies < 0)) out.push(`boards.${b.slug}: дивне число компаній`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.checked_at)) out.push(`boards.${b.slug}: checked_at має бути YYYY-MM-DD`);
    if (b.platform === "getro") {
      if (!b.platform_id || !/^[1-9]\d{0,6}$/.test(b.platform_id)) out.push(`boards.${b.slug}: Getro без номера колекції`);
      else if (getroIds.has(b.platform_id) && b.decision === "discover") out.push(`boards.${b.slug}: колекція ${b.platform_id} уже є`);
      else if (b.decision === "discover") getroIds.add(b.platform_id);
    }
    if (b.decision === "discover" && b.platform !== "getro") out.push(`boards.${b.slug}: розвідка вміє лише Getro`);
    // Consider забороняє збір: такі дошки лише 'skip' або 'manual' (портфель з публічної сторінки фонду).
    if (b.platform === "consider" && b.decision === "discover") out.push(`boards.${b.slug}: Consider не читаємо`);
  }
  return out;
}

export function loadBoardRegistry(path = BOARDS_PATH): BoardRegistry {
  const reg = JSON.parse(readFileSync(path, "utf8")) as BoardRegistry;
  const problems = boardProblems(reg);
  if (problems.length) throw new Error(`реєстр дошок ${path} не годиться: ${problems.slice(0, 5).join("; ")}`);
  return reg;
}

const hostOf = (url: string | null): string | null => {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
};

/** Дошки Getro, які розвідка читає (рішення 'discover'). */
export const getroBoards = (reg: BoardRegistry): GetroBoard[] =>
  reg.boards.filter((b) => b.platform === "getro" && b.decision === "discover" && b.platform_id)
    .map((b) => ({ slug: b.slug, label: b.label, collectionId: Number(b.platform_id), host: hostOf(b.url), cryptoScope: b.crypto_scope }));

/** Рядок job_boards для GetroBoard (те саме, що getroBoards, але з бази). */
export function getroBoardFromRow(r: { slug: string; label: string; url: string | null; platform_id: string | null; crypto_scope: string }): GetroBoard | null {
  const id = Number(r.platform_id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const scope = SCOPES.find((x) => x === r.crypto_scope) ?? "all";
  return { slug: r.slug, label: r.label, collectionId: id, host: hostOf(r.url), cryptoScope: scope };
}

const q = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

/** INSERT рядків job_boards. ON CONFLICT DO NOTHING: рядок, змінений руками в базі, не чіпається. */
export function boardsSql(reg: BoardRegistry): string[] {
  return reg.boards.map((b) => `INSERT INTO job_boards (slug, label, kind, url, platform, platform_id, companies, decision, crypto_scope, reason, checked_at) VALUES (${[
    b.slug, b.label, b.kind, b.url, b.platform, b.platform_id, b.companies, b.decision, b.crypto_scope, b.reason, b.checked_at].map(q).join(", ")}) ON CONFLICT(slug) DO NOTHING;`);
}

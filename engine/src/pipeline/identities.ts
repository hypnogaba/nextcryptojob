// Ідентичності людини з D1 → входи збирачів (docs/contracts.md §2).
import type { IdentityKind, SourceKey } from "../types.js";
import type { Db } from "./db.js";

export type IdentityRow = {
  id: number;
  kind: IdentityKind;
  value: string;
  verified_at: string | null;
};

/**
 * Входи збирачів однієї людини.
 * Модель довіри з 13.09 (docs/DECISIONS.md): X, GitHub і гаманці, які людина вписала сама, рахуються
 * як є, без коду в біо й без підпису. `verified` = рядок має `verified_at` (підтверджений до 13.09 або
 * забраний у «загарбника» кодом заявки); решта самозаявлена (selfReportedSources).
 * Профіль Sherlock звіряється лише з підтвердженими GitHub або X: інакше будь-хто вписав би чужий
 * GitHub і забрав чужий заробіток аудитора (поле Sherlock з анкети прибрано, рушій його не ламає).
 */
export type CollectorInputs = {
  x: { handle: string; verified: boolean } | null;
  github: { login: string; verified: boolean } | null;
  youtube: string | null;
  site: string | null;
  evm: string[];
  solana: string[];
  sherlock: string | null;
};

export const EMPTY_INPUTS: CollectorInputs = {
  x: null, github: null, youtube: null, site: null, evm: [], solana: [], sherlock: null,
};

export async function loadIdentities(db: Db, userId: string): Promise<IdentityRow[]> {
  return db.query<IdentityRow>(
    "SELECT id, kind, value, verified_at FROM identities WHERE user_id = ? ORDER BY id", [userId]);
}

/**
 * Групує рядки. Кілька значень одного виду (крім гаманців): береться підтверджене,
 * серед рівних найстаріше (менший id). Гаманці всі, без повторів, у порядку додавання.
 */
export function groupIdentities(rows: readonly IdentityRow[]): CollectorInputs {
  const sorted = [...rows].sort((a, b) => Number(!!b.verified_at) - Number(!!a.verified_at) || a.id - b.id);
  const first = (kind: IdentityKind): IdentityRow | undefined => sorted.find((r) => r.kind === kind && r.value.trim() !== "");
  const all = (kind: IdentityKind): string[] =>
    [...new Set(rows.filter((r) => r.kind === kind).sort((a, b) => a.id - b.id).map((r) => r.value.trim()).filter(Boolean))];

  const x = first("x");
  const gh = first("github");
  return {
    x: x ? { handle: x.value.trim(), verified: !!x.verified_at } : null,
    github: gh ? { login: gh.value.trim(), verified: !!gh.verified_at } : null,
    youtube: first("youtube")?.value.trim() ?? null,
    site: first("site")?.value.trim() ?? null,
    evm: all("evm"),
    solana: all("solana"),
    sherlock: first("sherlock")?.value.trim() ?? null,
  };
}

/** Джерела, які стосуються людини (рядки `source_facts`), у сталому порядку. */
export function plannedSources(i: CollectorInputs): SourceKey[] {
  const out: SourceKey[] = [];
  if (i.x) out.push("x");
  if (i.github) out.push("github", "dune");
  if (i.youtube) out.push("youtube");
  if (i.site) out.push("site");
  if (i.evm.length) out.push("evm", "hyperliquid");
  if (i.solana.length) out.push("solana");
  if (i.sherlock) out.push("audits");
  return out;
}

/**
 * Джерела, які людина вписала сама і які ніхто не підтверджував: X і GitHub без `verified_at`,
 * гаманці завжди (підпису немає), YouTube і сайт завжди. Для журналу рушія й для показу «self-reported».
 */
export function selfReportedSources(i: CollectorInputs): SourceKey[] {
  const out: SourceKey[] = [];
  if (i.x && !i.x.verified) out.push("x");
  if (i.github && !i.github.verified) out.push("github");
  if (i.youtube) out.push("youtube");
  if (i.site) out.push("site");
  if (i.evm.length) out.push("evm");
  if (i.solana.length) out.push("solana");
  return out;
}

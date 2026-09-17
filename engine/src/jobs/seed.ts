// Засів бази вакансій: реєстр роботодавців, дошок і колекцій (db/jobs/seed/registry.json).
// Файл складає разовий скрипт engine/scripts/jobs-seed.ts з публічних даних; тут лише форма,
// перевірка й SQL для `wrangler d1 execute --file`. Сухий скан без бази читає реєстр звідси.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comeetSlug, hostSlug, workdaySlug } from "./sources/ats.js";
import { type AtsProvider, type BoardSource, type Company, type GetroCollection, isAtsProvider, type SourceKind } from "./types.js";

export interface SeedCompany {
  slug: string; name: string; ats_provider: AtsProvider; ats_slug: string; discovered_via: string;
  /** 0: у реєстрі, але скан не читає (причина в note). */
  enabled: 0 | 1;
  note: string | null;
}
export interface SeedSource {
  name: string; label: string; kind: SourceKind; feed_url: string; site_url: string | null;
  crypto_only: 0 | 1; enabled: 0 | 1; terms_note: string | null;
}
export interface SeedGetro { collection_id: number; label: string; url: string | null; enabled: 0 | 1 }

export interface SeedRegistry {
  version: 1;
  /** Звідки й коли: лише опис, у базу не йде. */
  source: string;
  companies: SeedCompany[];
  sources: SeedSource[];
  getro_collections: SeedGetro[];
}

export const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/jobs/seed/registry.json");

const SOURCE_KINDS: readonly SourceKind[] = ["jsonld", "nextjs", "rss", "speedrun"];

/** Помилки форми реєстру; порожньо = годиться. Лише публічні поля, відомі провайдери, живі адреси. */
export function seedProblems(reg: SeedRegistry): string[] {
  const out: string[] = [];
  const allowedCompany = new Set(["slug", "name", "ats_provider", "ats_slug", "discovered_via", "enabled", "note"]);
  const slugs = new Set<string>();
  const boards = new Set<string>();
  for (const c of reg.companies) {
    for (const k of Object.keys(c)) if (!allowedCompany.has(k)) out.push(`companies.${c.slug}: зайве поле ${k}`);
    if (!c.slug || slugs.has(c.slug)) out.push(`companies: повтор або порожній slug ${c.slug}`);
    slugs.add(c.slug);
    if (!c.name?.trim()) out.push(`companies.${c.slug}: без назви`);
    if (c.enabled !== 0 && c.enabled !== 1) out.push(`companies.${c.slug}: enabled має бути 0 або 1`);
    if (!isAtsProvider(c.ats_provider)) out.push(`companies.${c.slug}: невідомий провайдер ${String(c.ats_provider)}`);
    const board = `${c.ats_provider}:${c.ats_slug.toLowerCase()}`;
    if (boards.has(board)) out.push(`companies.${c.slug}: дошка ${board} уже є`);
    boards.add(board);
    if (!/^[a-z0-9][a-z0-9_.%-]{0,80}$/i.test(c.ats_slug)) out.push(`companies.${c.slug}: дивний ats_slug ${c.ats_slug}`);
    if (["workable", "smartrecruiters", "recruitee", "breezy", "bamboohr", "rippling", "personio", "gem", "pinpoint", "hibob"].includes(c.ats_provider)) {
      try { hostSlug(c.ats_slug, c.ats_provider); } catch (e) { out.push(`companies.${c.slug}: ${(e as Error).message}`); }
    }
    if (c.ats_provider === "workday") {
      try { workdaySlug(c.ats_slug); } catch (e) { out.push(`companies.${c.slug}: ${(e as Error).message}`); }
    }
    if (c.ats_provider === "comeet") {
      try { comeetSlug(c.ats_slug); } catch (e) { out.push(`companies.${c.slug}: ${(e as Error).message}`); }
    }
  }
  for (const s of reg.sources) {
    if (!/^(board|aggregator):[a-z0-9-]+$/.test(s.name)) out.push(`sources: дивна назва ${s.name}`);
    if (!SOURCE_KINDS.includes(s.kind)) out.push(`sources.${s.name}: невідомий вид ${s.kind}`);
    if (!/^https:\/\//.test(s.feed_url)) out.push(`sources.${s.name}: адреса не https`);
  }
  for (const g of reg.getro_collections) {
    if (!Number.isInteger(g.collection_id) || g.collection_id <= 0) out.push(`getro: дивний id ${g.collection_id}`);
  }
  return out;
}

export function loadSeed(path = SEED_PATH): SeedRegistry {
  const reg = JSON.parse(readFileSync(path, "utf8")) as SeedRegistry;
  const problems = seedProblems(reg);
  if (problems.length) throw new Error(`реєстр ${path} не годиться: ${problems.slice(0, 5).join("; ")}`);
  return reg;
}

export const seedCompanies = (reg: SeedRegistry): Company[] =>
  reg.companies.filter((c) => c.enabled === 1).map((c) => ({ slug: c.slug, name: c.name, provider: c.ats_provider, atsSlug: c.ats_slug }));

export const seedBoards = (reg: SeedRegistry): BoardSource[] =>
  reg.sources.filter((s) => s.enabled === 1)
    .map((s) => ({ name: s.name, label: s.label, kind: s.kind, feedUrl: s.feed_url, cryptoOnly: s.crypto_only === 1 }));

export const seedGetro = (reg: SeedRegistry): GetroCollection[] =>
  reg.getro_collections.filter((g) => g.enabled === 1).map((g) => ({ id: g.collection_id, label: g.label }));

const q = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

/**
 * SQL засіву. ON CONFLICT DO NOTHING: повторне накочування не стирає того, що змінили руками
 * чи розвідка (вимкнену компанію не вмикає, назву не повертає).
 */
/**
 * Доповнення живої бази до нового реєстру без повного засіву: нові компанії (ON CONFLICT DO NOTHING,
 * наявний рядок не чіпається) і нові feed_url/terms_note дошок (UPDATE лише цих полів). Повторне
 * накочування нічого не міняє. Мітка в schema_migrations каже, що доповнення лягло.
 */
export function registryUpdateSql(reg: SeedRegistry, u: { name: string; note: string; companies: readonly string[]; sources: readonly string[] }): string {
  const out = [
    `-- Доповнення реєстру живої бази nextcryptojob-jobs (${u.name}). ЗГЕНЕРОВАНО з db/jobs/seed/registry.json:`,
    "--   cd engine && npx tsx scripts/jobs-seed.ts update",
    `-- ${u.note}`,
    "-- Накочує controller: wrangler d1 execute nextcryptojob-jobs --remote --file db/jobs/seed/<цей файл>",
  ];
  for (const name of u.sources) {
    const s = reg.sources.find((x) => x.name === name);
    if (!s) throw new Error(`немає дошки ${name} у реєстрі`);
    out.push(`UPDATE sources SET feed_url = ${q(s.feed_url)}, terms_note = ${q(s.terms_note)} WHERE name = ${q(s.name)};`);
  }
  const rows = u.companies.map((slug) => {
    const c = reg.companies.find((x) => x.slug === slug);
    if (!c) throw new Error(`немає компанії ${slug} у реєстрі`);
    return `(${[c.slug, c.name, c.ats_provider, c.ats_slug, c.enabled, c.discovered_via, c.note].map(q).join(", ")})`;
  });
  if (rows.length) out.push(`INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES\n  ${rows.join(",\n  ")}\n  ON CONFLICT DO NOTHING;`);
  out.push(`INSERT OR IGNORE INTO schema_migrations(name) VALUES (${q(u.name)});`);
  return `${out.join("\n")}\n`;
}

export function seedSql(reg: SeedRegistry): string {
  const out = [
    "-- Засів бази вакансій NextCryptoJob. ЗГЕНЕРОВАНО з db/jobs/seed/registry.json командою",
    "--   cd engine && npx tsx scripts/jobs-seed.ts sql",
    "-- Правити registry.json (або скрипт), а не цей файл: тест звіряє їх.",
    "-- Накочувати після 0001_schema.sql: wrangler d1 execute nextcryptojob-jobs --remote --file db/jobs/seed/seed.sql",
    `-- Джерело: ${reg.source}`,
  ];
  for (const s of reg.sources) {
    out.push(`INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES (${[
      s.name, s.label, s.kind, s.feed_url, s.site_url, s.crypto_only, s.enabled, s.terms_note].map(q).join(", ")}) ON CONFLICT(name) DO NOTHING;`);
  }
  for (const g of reg.getro_collections) {
    out.push(`INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (${[
      g.collection_id, g.label, g.url, g.enabled].map(q).join(", ")}) ON CONFLICT(collection_id) DO NOTHING;`);
  }
  // Пакетами по 20: один INSERT на сотні рядків D1 не любить, а по рядку забагато інструкцій.
  for (let i = 0; i < reg.companies.length; i += 20) {
    const rows = reg.companies.slice(i, i + 20)
      .map((c) => `(${[c.slug, c.name, c.ats_provider, c.ats_slug, c.enabled, c.discovered_via, c.note].map(q).join(", ")})`);
    out.push(`INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES\n  ${rows.join(",\n  ")}\n  ON CONFLICT DO NOTHING;`);
  }
  out.push("INSERT OR IGNORE INTO schema_migrations(name) VALUES ('seed_registry');");
  return `${out.join("\n")}\n`;
}

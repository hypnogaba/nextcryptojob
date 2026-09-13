import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@/lib/auth/hash";
import { resolveActor, type ActionContext, type ActorRequest, type CrmEnv } from "@/lib/crm/context";
import { generateApiKey } from "@/lib/crm/keys";
import { FORMULA_VERSION } from "@/lib/crm/types";
import { newId } from "@/lib/ids";
import { migratedD1, type TestDb } from "./sqlite-d1";

/**
 * Дані для тестів CRM на справжньому SQLite з усіма міграціями (0001–0009).
 * Лише Node, у Worker не імпортувати.
 */

export const ALL_MIGRATIONS = readdirSync(new URL("../../../db/migrations/", import.meta.url))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

export const CURSOR_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
export const TEST_ENV: CrmEnv = { SESSION_SECRET: CURSOR_SECRET };

export function crmDb(): TestDb {
  return migratedD1(ALL_MIGRATIONS);
}

type Value = string | number | null;

export function run(raw: DatabaseSync, sql: string, ...params: Value[]): void {
  raw.prepare(sql).run(...params);
}

export function all<T = Record<string, unknown>>(raw: DatabaseSync, sql: string, ...params: Value[]): T[] {
  return raw.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
}

export interface UserOpts {
  id?: string;
  email?: string | null;
  telegram?: string | null;
  roles?: string[];
  rolesJson?: string;
  visible?: boolean;
  /** Згода visibility: true (дана), false (відкликана), undefined = як visible. */
  consent?: boolean;
  consentAt?: string;
  contactMode?: "approval" | "direct";
  contactConsent?: boolean;
  remoteMode?: string | null;
  city?: string | null;
  salaryMin?: number | null;
  salaryCurrency?: string | null;
  targetText?: string | null;
}

export function addUser(raw: DatabaseSync, o: UserOpts = {}): string {
  const id = o.id ?? crypto.randomUUID();
  run(
    raw,
    `INSERT INTO users (id, email, telegram_username, roles, visible_to_companies, contact_mode,
                        remote_mode, city, salary_min, salary_currency, target_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    o.email === undefined ? `${id.slice(0, 8)}@example.com` : o.email,
    o.telegram ?? null,
    o.rolesJson ?? JSON.stringify(o.roles ?? ["engineer"]),
    (o.visible ?? true) ? 1 : 0,
    o.contactMode ?? "approval",
    o.remoteMode === undefined ? "remote" : o.remoteMode,
    o.city ?? null,
    o.salaryMin ?? null,
    o.salaryCurrency ?? null,
    o.targetText ?? null,
  );
  const consent = o.consent ?? o.visible ?? true;
  if (o.consent !== undefined || consent) {
    setConsent(raw, id, "visibility", consent, o.consentAt);
  }
  if (o.contactConsent) setConsent(raw, id, "contact", true);
  return id;
}

export function setConsent(raw: DatabaseSync, userId: string, kind: string, granted: boolean, at?: string): void {
  run(
    raw,
    `INSERT INTO consents (user_id, kind, granted, text_version, at) VALUES (?, ?, ?, 'v1', COALESCE(?, datetime('now')))
     ON CONFLICT(user_id, kind) DO UPDATE SET granted = excluded.granted, at = excluded.at`,
    userId,
    kind,
    granted ? 1 : 0,
    at ?? null,
  );
}

export interface ScoreOpts {
  cover?: number;
  formula?: string;
  breakdown?: Record<string, unknown>;
  computedAt?: string;
}

export function addScore(raw: DatabaseSync, userId: string, role: string, score: number | null, o: ScoreOpts = {}): void {
  const formula = o.formula ?? FORMULA_VERSION;
  const breakdown = o.breakdown ?? {
    formula,
    sources: { gh_eng: score, x: 40 },
    core: { gh_eng: { weight: 80, value: score }, x: { weight: 20, value: 40 } },
    bonus: { onchain: { max: 5, value: 50 } },
    cover: o.cover ?? 100,
    level: null,
    reason: score === null ? "missing_anchor:gh_eng" : null,
    gaps: {},
  };
  run(
    raw,
    `INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    userId,
    role,
    score,
    score,
    o.cover ?? 100,
    JSON.stringify(breakdown),
    formula,
    o.computedAt ?? null,
  );
}

export function publishFormula(raw: DatabaseSync, version: string = FORMULA_VERSION, passed = true): void {
  run(
    raw,
    `INSERT INTO quality_runs (formula_version, people, exact_pct, near_pct, unscored, report_json, passed)
     VALUES (?, 49, 60, 85, 0, '{}', ?)`,
    version,
    passed ? 1 : 0,
  );
}

export function addCompany(
  raw: DatabaseSync,
  o: { id?: string; name?: string; status?: string; kind?: string } = {},
): string {
  const id = o.id ?? newId("co");
  run(
    raw,
    `INSERT INTO companies (id, name, kind, status, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, 'v1', datetime('now'))`,
    id,
    o.name ?? "Acme Labs",
    o.kind ?? "company",
    o.status ?? "active",
  );
  return id;
}

export function addMember(raw: DatabaseSync, companyId: string, userId: string, role: "owner" | "member" = "owner"): void {
  run(
    raw,
    `INSERT INTO company_members (company_id, user_id, role, joined_at) VALUES (?, ?, ?, datetime('now'))`,
    companyId,
    userId,
    role,
  );
}

export function addSubscription(
  raw: DatabaseSync,
  companyId: string,
  o: { status?: string; provider?: "manual" | "usdc" | "stripe"; start?: string; end?: string } = {},
): string {
  const id = newId("sub");
  const provider = o.provider ?? "manual";
  run(
    raw,
    `INSERT INTO subscriptions (id, company_id, provider, status, current_period_start, current_period_end, stripe_subscription_id)
     VALUES (?, ?, ?, ?, COALESCE(?, datetime('now', '-1 day')), COALESCE(?, datetime('now', '+30 days')), ?)`,
    id,
    companyId,
    provider,
    o.status ?? "active",
    o.start ?? null,
    o.end ?? null,
    provider === "stripe" ? `sub_stripe_${id}` : null,
  );
  return id;
}

export async function addApiKey(
  raw: DatabaseSync,
  companyId: string,
  o: { revoked?: boolean; name?: string } = {},
): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const id = newId("key");
  run(
    raw,
    `INSERT INTO api_keys (id, company_id, name, prefix, key_hash, revoked_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    companyId,
    o.name ?? "agent",
    key.slice(0, 16),
    await sha256Hex(key),
    o.revoked ? "2026-09-01 00:00:00" : null,
  );
  return { id, key };
}

export function addIdentity(
  raw: DatabaseSync,
  userId: string,
  kind: string,
  value: string,
  o: { via?: string | null; verified?: boolean } = {},
): void {
  run(
    raw,
    `INSERT INTO identities (user_id, kind, value, verified_via, verified_at) VALUES (?, ?, ?, ?, ?)`,
    userId,
    kind,
    value,
    o.via ?? null,
    o.verified ? "2026-09-01 00:00:00" : null,
  );
}

export function addFacts(raw: DatabaseSync, userId: string, source: string, facts: unknown, gap: string | null = null): void {
  run(
    raw,
    `INSERT INTO source_facts (user_id, source, facts_json, gap_reason) VALUES (?, ?, ?, ?)`,
    userId,
    source,
    facts === null ? null : JSON.stringify(facts),
    gap,
  );
}

/** Рядок x402_payments у стані settled (для usage_events.x402_payment_id). */
export function addPayment(raw: DatabaseSync, o: { payer?: string; companyId?: string | null } = {}): string {
  const id = newId("pay");
  run(
    raw,
    `INSERT INTO x402_payments (id, payload_hash, request_hash, company_id, payer, network, asset, pay_to,
                                amount_atomic, amount_usd_cents, action, channel, status, facilitator)
     VALUES (?, ?, 'rh', ?, ?, 'eip155:84532', 'usdc', 'payto', '500000', 50, 'search_candidates', 'rest', 'settled', 'x402org')`,
    id,
    `ph_${id}`,
    o.companyId ?? null,
    o.payer ?? "0xpayer",
  );
  return id;
}

/** n успішних (або з іншим статусом) рядків usage_events у заданий час. */
export function addUsage(
  raw: DatabaseSync,
  n: number,
  o: { companyId?: string | null; payer?: string | null; action: string; at: string; status?: number },
): void {
  const stmt = raw.prepare(
    `INSERT INTO usage_events (company_id, payer, channel, action, billing, status, created_at)
     VALUES (?, ?, 'rest', ?, 'included', ?, ?)`,
  );
  for (let i = 0; i < n; i++) stmt.run(o.companyId ?? null, o.payer ?? null, o.action, o.status ?? 200, o.at);
}

/** Контекст через справжнє визначення актора (ключ, сесія або гість). */
export async function contextFor(
  db: TestDb,
  request: Omit<ActorRequest, "channel"> & { channel?: ActorRequest["channel"] },
  o: { now?: Date; env?: CrmEnv } = {},
): Promise<ActionContext> {
  return resolveActor(
    { db: db.d1, env: o.env ?? TEST_ENV, now: o.now, requestId: "req_test" },
    { ...request, channel: request.channel ?? (request.sessionUserId ? "web" : "rest") },
  );
}

import { sha256Hex } from "@/lib/auth/hash";
import { newId, randomBase62 } from "@/lib/ids";
import { writeAudit } from "./audit";
import { actorRole, API_KEY_PREFIX, type ActionContext } from "./context";
import { assertCan } from "./permissions";
import { SEATS } from "./quotas";
import { ActionError } from "./types";

/**
 * Ключі API компанії (0004 api_keys, специфікація 2.2 і 9). Створює лише
 * власник (member → 403 forbidden, агент → 403: ключ не видає ключів).
 * Ключ = `ncj_live_` + 43 символи base62 (~256 біт). У базі лише SHA-256 і
 * перші 16 символів для показу; сам ключ повертається один раз.
 */

export interface CreatedKey {
  key_id: string;
  name: string;
  prefix: string;
  /** Показати один раз; більше ніде не зберігається. */
  key: string;
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBase62(43)}`;
}

export async function createApiKey(ctx: ActionContext, name: string): Promise<CreatedKey> {
  assertCan(actorRole(ctx.actor), "api_keys.create");
  const company = ctx.company;
  if (ctx.actor.kind !== "member" || !company) throw new ActionError("forbidden", 403, "Only the company owner can create API keys.");
  if (company.status !== "active") throw new ActionError("company_not_active", 403, "This company account is not active.");

  const clean = name.trim();
  if (clean.length < 1 || clean.length > 60) {
    throw new ActionError("validation_failed", 422, "Some fields are not valid.", {
      fields: { name: "Name the key in 1 to 60 characters." },
    });
  }

  const seats = company.plan === "none" ? 0 : SEATS[company.plan].apiKeys;
  const key = generateApiKey();
  const id = newId("key");
  const prefix = key.slice(0, 16);
  // Межа ключів і запис одною інструкцією: паралельне створення не перебере межу.
  const inserted = await ctx.db
    .prepare(
      `INSERT INTO api_keys (id, company_id, name, prefix, key_hash, created_by_user_id)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM api_keys WHERE company_id = ? AND revoked_at IS NULL) < ?
       RETURNING id`,
    )
    .bind(id, company.id, clean, prefix, await sha256Hex(key), ctx.actor.userId, company.id, seats)
    .first<{ id: string }>();
  if (!inserted) {
    throw new ActionError("quota_exceeded", 403, `Your plan allows ${seats} active API keys. Revoke one first.`, {
      limit: seats,
    });
  }
  await writeAudit(ctx, { action: "api_key.create", meta: { key_id: id } });
  return { key_id: id, name: clean, prefix, key };
}

export async function revokeApiKey(ctx: ActionContext, keyId: string): Promise<void> {
  assertCan(actorRole(ctx.actor), "api_keys.revoke");
  const companyId = ctx.company?.id ?? null;
  const userId = ctx.actor.kind === "member" || ctx.actor.kind === "admin" ? ctx.actor.userId : null;
  // Власник відкликає лише ключі своєї компанії; адмін будь-які.
  const res = await ctx.db
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now'), revoked_by_user_id = ?
        WHERE id = ? AND revoked_at IS NULL AND (? IS NULL OR company_id = ?)`,
    )
    .bind(userId, keyId, ctx.actor.kind === "admin" ? null : companyId, companyId)
    .run();
  if (res.meta.changes !== 1) throw new ActionError("not_found", 404, "This API key does not exist or is already revoked.");
  await writeAudit(ctx, { action: "api_key.revoke", meta: { key_id: keyId } });
}

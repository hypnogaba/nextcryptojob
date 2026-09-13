import { normaliseEmail } from "@/lib/auth/email-code";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { consume, type Limits } from "@/lib/auth/ratelimit";
import type { Mailer } from "@/lib/mail";
import { fromSqlTime, sqlTime } from "@/lib/time";
import {
  CompanyError,
  LAST_OWNER_TEXT,
  auditIfChanged,
  inactiveError,
  memberContext,
  memberOf,
  personLabel,
} from "./company";
import { inviteEmail, sendAll } from "./company-mail";
import { actorRole, loadCompany, type ActionContext, type CompanyInfo } from "./context";
import { assertCan } from "./permissions";
import { SEATS } from "./quotas";

/**
 * Команда компанії (специфікація CRM, 6.3; права 2.2: запросити, прибрати,
 * змінити роль може лише власник).
 *
 * - Запрошення: рядок company_members з invite_email і SHA-256 токена; живе
 *   INVITE_DAYS днів; прийняти може лише людина, що ввійшла з цією поштою
 *   (users.email з'являється тільки після входу кодом з листа, тож підтверджена).
 *   Токен одноразовий: після прийняття хеш стає NULL.
 * - Місця (розділ 9): члени плюс чинні запрошення не більше межі плану.
 * - Останній власник не може піти, стати членом чи бути прибраним:
 *   LAST_OWNER_TEXT. Правило діє, доки компанію не закрито.
 * - Прибраний член втрачає доступ з наступного запиту: рядка членства немає,
 *   і context.ts його не знаходить. Його нотатки лишаються з підписом
 *   "Former member" (company.ts, memberLabels).
 */

export const INVITE_DAYS = 7;

/** Нові запрошення від однієї компанії: не більше 20 листів на годину. */
const INVITE_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 60 };

/** Скільки людей може бути в команді (члени + чинні запрошення). */
export function seatLimit(company: Pick<CompanyInfo, "plan">): number {
  return company.plan === "none" ? 0 : SEATS[company.plan].members;
}

/** Запрошення чинне, якщо надіслане не раніше, ніж INVITE_DAYS днів тому (SQL-вираз). */
const OPEN_INVITE = `(user_id IS NULL AND invited_at > datetime(?, '-${INVITE_DAYS} days'))`;

/** Власників (людей, не запрошень) у компанії. */
const OWNERS = "(SELECT COUNT(*) FROM company_members o WHERE o.company_id = ? AND o.role = 'owner' AND o.user_id IS NOT NULL)";

// ---------------------------------------------------------------------------
// Список

export interface TeamMember {
  userId: string;
  label: string;
  role: "owner" | "member";
  joinedAt: string | null;
  lastSeenAt: string | null;
  isMe: boolean;
}

export interface PendingInvite {
  id: number;
  email: string;
  invitedAt: string;
  expiresAt: Date;
  expired: boolean;
}

export interface Team {
  members: TeamMember[];
  invites: PendingInvite[];
  seats: { used: number; limit: number };
  owners: number;
}

export function inviteExpiry(invitedAt: string): Date {
  return new Date(fromSqlTime(invitedAt).getTime() + INVITE_DAYS * 86_400_000);
}

/** Члени й запрошення. Бачить уся команда (settings.read); змінює лише власник. */
export async function loadTeam(ctx: ActionContext): Promise<Team> {
  assertCan(actorRole(ctx.actor), "settings.read");
  const me = memberOf(ctx);
  const { results } = await ctx.db
    .prepare(
      `SELECT m.id, m.user_id, m.role, m.invite_email, m.invited_at, m.joined_at, m.last_seen_at, u.email, u.telegram_username
         FROM company_members m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ?
        ORDER BY m.user_id IS NULL, m.role = 'member', COALESCE(m.joined_at, m.invited_at), m.id`,
    )
    .bind(me.companyId)
    .all<{
      id: number;
      user_id: string | null;
      role: "owner" | "member";
      invite_email: string | null;
      invited_at: string | null;
      joined_at: string | null;
      last_seen_at: string | null;
      email: string | null;
      telegram_username: string | null;
    }>();

  const members: TeamMember[] = [];
  const invites: PendingInvite[] = [];
  for (const r of results) {
    if (r.user_id) {
      members.push({
        userId: r.user_id,
        label: personLabel(r.email, r.telegram_username),
        role: r.role,
        joinedAt: r.joined_at,
        lastSeenAt: r.last_seen_at,
        isMe: r.user_id === me.userId,
      });
    } else if (r.invite_email && r.invited_at) {
      const expiresAt = inviteExpiry(r.invited_at);
      invites.push({ id: r.id, email: r.invite_email, invitedAt: r.invited_at, expiresAt, expired: expiresAt <= ctx.now });
    }
  }
  const used = members.length + invites.filter((i) => !i.expired).length;
  return {
    members,
    invites,
    seats: { used, limit: seatLimit(me.company) },
    owners: members.filter((m) => m.role === "owner").length,
  };
}

// ---------------------------------------------------------------------------
// Запрошення

export interface InviteResult {
  email: string;
  expiresAt: Date;
  /** Лист пішов. */
  emailed: boolean;
  /** Посилання для копіювання, коли листа не надіслано (пошти немає або вона відмовила). */
  link: string | null;
}

/**
 * "Invite teammate". Повторне запрошення тієї самої пошти замінює старе (новий
 * токен, новий строк). Межа місць перевіряється в тій самій інструкції, що й запис.
 */
export async function inviteMember(
  ctx: ActionContext,
  rawEmail: string,
  opts: { origin: string; mailer: Mailer | null },
): Promise<InviteResult> {
  assertCan(actorRole(ctx.actor), "team.manage");
  const me = memberOf(ctx);
  if (me.company.status !== "active") throw inactiveError(me.company.status);

  const email = normaliseEmail(rawEmail);
  if (!email) {
    throw new CompanyError("validation_failed", "Enter a valid email address.", { email: "Enter a valid email address." });
  }
  const already = await ctx.db
    .prepare(
      `SELECT 1 AS yes FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND lower(u.email) = ?`,
    )
    .bind(me.companyId, email)
    .first();
  if (already) throw new CompanyError("already_member", "This person is already on your team.");

  const verdict = await consume(`invite:${me.companyId}`, INVITE_LIMITS, ctx.db);
  if (!verdict.allowed) {
    throw new CompanyError("rate_limited", `Too many invites. Try again in ${verdict.retryAfterMinutes} minutes.`);
  }

  const limit = seatLimit(me.company);
  const token = randomToken();
  const hash = await sha256Hex(token);
  const at = sqlTime(ctx.now);
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM company_members WHERE company_id = ? AND user_id IS NULL AND invite_email = ?")
      .bind(me.companyId, email),
    ctx.db
      .prepare(
        `INSERT INTO company_members (company_id, role, invite_email, invite_token_hash, invited_by, invited_at)
         SELECT ?1, 'member', ?2, ?3, ?4, ?5
          WHERE (SELECT COUNT(*) FROM company_members
                  WHERE company_id = ?1 AND (user_id IS NOT NULL OR ${OPEN_INVITE.replace("?", "?5")})) < ?6`,
      )
      .bind(me.companyId, email, hash, me.userId, at, limit),
    // Пошту в журнал не пишемо (audit_log живе довше за дані): лише сам факт запрошення.
    auditIfChanged(ctx, { action: "team.invite", meta: { role: "member" } }),
  ]);

  const row = await ctx.db.prepare("SELECT id FROM company_members WHERE invite_token_hash = ?").bind(hash).first();
  if (!row) {
    throw new CompanyError(
      "seat_limit",
      `Your plan allows ${limit} people on the team, pending invites included. Remove someone or cancel an invite first.`,
    );
  }

  const expiresAt = inviteExpiry(at);
  const link = `${opts.origin}/company/join?t=${token}`;
  const inviter = await ctx.db
    .prepare("SELECT email, telegram_username FROM users WHERE id = ?")
    .bind(me.userId)
    .first<{ email: string | null; telegram_username: string | null }>();
  const emailed = await sendAll(
    opts.mailer,
    [email],
    inviteEmail({
      inviter: inviter ? personLabel(inviter.email, inviter.telegram_username) : "A teammate",
      company: me.company.name,
      link,
      expiresAt,
    }),
  );
  return { email, expiresAt, emailed, link: emailed ? null : link };
}

/** Скасувати запрошення: посилання з листа більше не працює. */
export async function revokeInvite(ctx: ActionContext, inviteId: number): Promise<void> {
  assertCan(actorRole(ctx.actor), "team.manage");
  const me = memberOf(ctx);
  const [deleted] = await ctx.db.batch([
    ctx.db.prepare("DELETE FROM company_members WHERE id = ? AND company_id = ? AND user_id IS NULL").bind(inviteId, me.companyId),
    auditIfChanged(ctx, { action: "team.invite_revoke", meta: { invite_id: inviteId } }),
  ]);
  if ((deleted?.meta.changes ?? 0) === 0) throw new CompanyError("not_found", "This invite does not exist or was already used.");
}

// ---------------------------------------------------------------------------
// Прийняття (/company/join?t=)

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type InviteView =
  | { state: "invalid" }
  | { state: "expired"; companyName: string }
  | { state: "valid"; companyId: string; companyName: string; companyStatus: CompanyInfo["status"]; email: string; maskedEmail: string; expiresAt: Date };

/** "d***@acme.io": видно, на яку пошту запрошення, без самої адреси. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Що каже посилання запрошення. Використане, скасоване й чуже виглядають однаково: "invalid". */
export async function findInvite(db: D1Database, token: string, now = new Date()): Promise<InviteView> {
  if (!TOKEN_SHAPE.test(token)) return { state: "invalid" };
  const row = await db
    .prepare(
      `SELECT m.company_id, m.invite_email, m.invited_at, c.name, c.status
         FROM company_members m JOIN companies c ON c.id = m.company_id
        WHERE m.invite_token_hash = ? AND m.user_id IS NULL`,
    )
    .bind(await sha256Hex(token))
    .first<{ company_id: string; invite_email: string | null; invited_at: string | null; name: string; status: CompanyInfo["status"] }>();
  if (!row || !row.invite_email || !row.invited_at) return { state: "invalid" };
  const expiresAt = inviteExpiry(row.invited_at);
  if (expiresAt <= now) return { state: "expired", companyName: row.name };
  return {
    state: "valid",
    companyId: row.company_id,
    companyName: row.name,
    companyStatus: row.status,
    email: row.invite_email,
    maskedEmail: maskEmail(row.invite_email),
    expiresAt,
  };
}

/**
 * Прийняти запрошення. Лише людина з сесії, чия підтверджена пошта дорівнює
 * пошті запрошення; чинне (7 днів), не використане, компанія працює, є місце.
 * Один UPDATE з усіма умовами: подвійне натискання чи два вкладки не додадуть двох.
 */
export async function acceptInvite(
  db: D1Database,
  user: { id: string; email: string | null },
  token: string,
  now = new Date(),
): Promise<{ companyId: string; companyName: string; alreadyMember: boolean }> {
  const invite = await findInvite(db, token, now);
  if (invite.state === "invalid") {
    throw new CompanyError("invite_invalid", "This invite link is not valid or was already used. Ask the owner for a new one.");
  }
  if (invite.state === "expired") {
    throw new CompanyError("invite_expired", "This invite has expired. Ask the owner to send a new one.");
  }
  if (!user.email) {
    throw new CompanyError(
      "email_required",
      `Sign in with the email this invite was sent to (${invite.maskedEmail}) to accept it.`,
    );
  }
  if (user.email.trim().toLowerCase() !== invite.email) {
    throw new CompanyError(
      "invite_email_mismatch",
      `This invite was sent to ${invite.maskedEmail}. Sign out and sign in with that email to accept it.`,
    );
  }
  if (invite.companyStatus !== "active") throw inactiveError(invite.companyStatus);

  const hash = await sha256Hex(token);
  const member = await db
    .prepare("SELECT 1 AS yes FROM company_members WHERE company_id = ? AND user_id = ?")
    .bind(invite.companyId, user.id)
    .first();
  if (member) {
    // Уже в команді (напр. прийняв інше запрошення): це запрошення більше не потрібне.
    await db.prepare("DELETE FROM company_members WHERE invite_token_hash = ? AND user_id IS NULL").bind(hash).run();
    return { companyId: invite.companyId, companyName: invite.companyName, alreadyMember: true };
  }

  const company = await loadCompany(db, invite.companyId);
  const limit = company ? seatLimit(company) : 0;
  const at = sqlTime(now);
  const ctx = memberContext(db, { userId: user.id, companyId: invite.companyId, role: "member" }, company, now);
  const [joined] = await db.batch([
    db
      .prepare(
        `UPDATE company_members SET user_id = ?1, joined_at = ?2, last_seen_at = ?2, invite_token_hash = NULL
          WHERE invite_token_hash = ?3 AND user_id IS NULL AND invited_at > datetime(?2, '-${INVITE_DAYS} days')
            AND (SELECT COUNT(*) FROM company_members WHERE company_id = ?4 AND user_id IS NOT NULL) < ?5`,
      )
      .bind(user.id, at, hash, invite.companyId, limit),
    auditIfChanged(ctx, { action: "team.join", meta: { role: "member" } }),
  ]);
  if ((joined?.meta.changes ?? 0) > 0) {
    return { companyId: invite.companyId, companyName: invite.companyName, alreadyMember: false };
  }

  // Не приєднали: чому саме. Запрошення могли скасувати, використати чи воно
  // саме прострочилось між читанням і записом; лише інакше це повна команда.
  const again = await findInvite(db, token, now);
  if (again.state === "invalid") {
    throw new CompanyError("invite_invalid", "This invite link is not valid or was already used. Ask the owner for a new one.");
  }
  if (again.state === "expired") {
    throw new CompanyError("invite_expired", "This invite has expired. Ask the owner to send a new one.");
  }
  throw new CompanyError("seat_limit", "This team is full. Ask the owner to free a seat, then open the link again.");
}

// ---------------------------------------------------------------------------
// Ролі, прибрати, піти

const NOT_ON_TEAM = "This person is not on your team.";

async function currentRole(db: D1Database, companyId: string, userId: string): Promise<"owner" | "member" | null> {
  return db
    .prepare("SELECT role FROM company_members WHERE company_id = ? AND user_id = ?")
    .bind(companyId, userId)
    .first<"owner" | "member">("role");
}

async function targetRole(db: D1Database, companyId: string, userId: string): Promise<"owner" | "member"> {
  const role = await currentRole(db, companyId, userId);
  if (!role) throw new CompanyError("not_found", NOT_ON_TEAM);
  return role;
}

/** Закриту компанію нікому передавати, тож правило останнього власника там не діє. */
function ownerRuleApplies(company: CompanyInfo): boolean {
  return company.status !== "closed";
}

/** "Make owner" / "Make member". Останній власник членом не стане. */
export async function changeRole(ctx: ActionContext, userId: string, role: "owner" | "member"): Promise<void> {
  assertCan(actorRole(ctx.actor), "team.manage");
  const me = memberOf(ctx);
  if (me.company.status === "closed") throw inactiveError("closed");
  if (role !== "owner" && role !== "member") throw new CompanyError("validation_failed", "Choose Owner or Member.");
  const current = await targetRole(ctx.db, me.companyId, userId);
  if (current === role) return;

  const res = await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE company_members SET role = ?1
          WHERE company_id = ?2 AND user_id = ?3 AND role <> ?1
            AND (?1 = 'owner' OR ${OWNERS.replace("?", "?2")} > 1)`,
      )
      .bind(role, me.companyId, userId),
    auditIfChanged(ctx, { action: "team.role", meta: { member_user_id: userId, role } }),
  ]);
  if ((res[0]?.meta.changes ?? 0) > 0) return;
  // Нічого не змінилось: людину тим часом прибрали, роль уже така, або це останній власник.
  const now = await currentRole(ctx.db, me.companyId, userId);
  if (!now) throw new CompanyError("not_found", NOT_ON_TEAM);
  if (now === role) return;
  throw new CompanyError("last_owner", LAST_OWNER_TEXT);
}

/** Прибрати рядок членства, якщо це не останній власник живої компанії. */
async function dropMember(ctx: ActionContext, userId: string, action: "team.remove" | "team.leave"): Promise<void> {
  const me = memberOf(ctx);
  const role = await targetRole(ctx.db, me.companyId, userId);
  const guardOwners = ownerRuleApplies(me.company) ? 1 : 0;
  const res = await ctx.db.batch([
    ctx.db
      .prepare(
        `DELETE FROM company_members
          WHERE company_id = ?1 AND user_id = ?2
            AND (role <> 'owner' OR ?3 = 0 OR ${OWNERS.replace("?", "?1")} > 1)`,
      )
      .bind(me.companyId, userId, guardOwners),
    auditIfChanged(ctx, { action, meta: action === "team.remove" ? { member_user_id: userId, role } : { role } }),
  ]);
  if ((res[0]?.meta.changes ?? 0) > 0) return;
  // Нічого не видалено: людини вже немає (друга вкладка, інший власник) чи це останній власник.
  if (!(await currentRole(ctx.db, me.companyId, userId))) throw new CompanyError("not_found", NOT_ON_TEAM);
  throw new CompanyError("last_owner", LAST_OWNER_TEXT);
}

/** "Remove". Себе прибрати не можна кнопкою Remove: для цього "Leave the team". */
export async function removeMember(ctx: ActionContext, userId: string): Promise<void> {
  assertCan(actorRole(ctx.actor), "team.manage");
  const me = memberOf(ctx);
  if (userId === me.userId) throw new CompanyError("validation_failed", "Use Leave the team to leave this company.");
  await dropMember(ctx, userId, "team.remove");
}

/** "Leave the team": будь-хто з команди, крім останнього власника. */
export async function leaveCompany(ctx: ActionContext): Promise<void> {
  const me = memberOf(ctx);
  await dropMember(ctx, me.userId, "team.leave");
}

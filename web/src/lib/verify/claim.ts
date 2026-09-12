// Забрати нік X чи GitHub у неперевіреного «загарбника». Хтось міг ввести чужий
// нік і не підтвердити його; UNIQUE(kind, value) тоді блокує справжнього власника.
// Власник отримує власний код заявки (HMAC від SESSION_SECRET, нічого не
// зберігаємо), ставить його в біо чи пост, і після перевірки рядок переходить до нього.
import { hmacSha256Hex } from "@/lib/auth/hash";
import { takeOverIdentity } from "@/lib/identity/store";
import { codeFromBytes } from "./code";
import { checkGate, checkIdentity, findCode, type CheckDeps, type CheckOutcome, type VerifiableKind } from "./check";

/**
 * Код заявки: той самий вигляд ncj-xxxxxx, стале значення для людини, джерела й
 * ніка. Без SESSION_SECRET його не вгадати, тож «загарбник» не підставить свій.
 */
export async function claimCode(secret: string, kind: VerifiableKind, value: string, userId: string): Promise<string> {
  const hex = await hmacSha256Hex(secret, `claim:${kind}:${value}:${userId}`);
  const bytes = Uint8Array.from(hex.slice(0, 12).match(/../g)!, (h) => parseInt(h, 16));
  return codeFromBytes(bytes);
}

/** Хто тримає нік: ніхто, інший без підтвердження, інший з підтвердженням, сама людина. */
export type Holder = "free" | "pending" | "taken" | "mine";

export async function holderOf(db: D1Database, userId: string, kind: VerifiableKind, value: string): Promise<Holder> {
  const row = await db
    .prepare("SELECT user_id, verified_at FROM identities WHERE kind = ? AND value = ?")
    .bind(kind, value)
    .first<{ user_id: string; verified_at: string | null }>();
  if (!row) return "free";
  if (row.user_id === userId) return "mine";
  return row.verified_at ? "taken" : "pending";
}

/**
 * Перевіряє код заявки в профілі й, якщо він там є, передає нік людині вже
 * перевіреним. Якщо той профіль тим часом підтвердив нік, передачі немає.
 */
export async function checkClaim(
  db: D1Database,
  userId: string,
  kind: VerifiableKind,
  value: string,
  deps: CheckDeps & { secret: string },
): Promise<CheckOutcome> {
  const holder = await holderOf(db, userId, kind, value);
  if (holder === "taken") return { status: "taken" };
  // Нік уже в людини (той профіль його прибрав, і людина додала заново): звичайна перевірка.
  if (holder === "mine") return checkIdentity(db, userId, kind, deps);

  const blocked = await checkGate(db, userId, kind, deps);
  if (blocked) return blocked;
  const code = await claimCode(deps.secret, kind, value, userId);
  const found = await findCode(kind, value, code, deps);
  if (found.status !== "found") return found;
  if (!(await takeOverIdentity(db, userId, kind, value, found.via))) return { status: "taken" };
  return { status: "verified", via: found.via };
}

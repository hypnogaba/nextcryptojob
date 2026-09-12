// Перевірка коду в біо (X, GitHub) або у власному пості (X) для джерела людини.
// Кожна перевірка X коштує балів 6551, тому є ліміт на людину.
import { consume, type Limits } from "@/lib/auth/ratelimit";
import { getIdentity, markVerified } from "@/lib/identity/store";
import { containsCode, isVerifyCode } from "./code";
import { readGithubBio, readXBio, readXPosts } from "./sources";

export type VerifiableKind = "x" | "github";
export type Via = "bio_code" | "post_code";

/** 10 перевірок на годину на людину для кожного джерела окремо (разом зі спробами забрати нік). */
export const CHECK_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 10, blockMinutes: 60 };

/** Що дало читання профілю. */
export type FindResult =
  | { status: "found"; via: Via }
  | { status: "code_missing" }
  | { status: "not_found" }
  | { status: "busy" }
  | { status: "unavailable" }
  | { status: "source_limited" };

export type CheckOutcome =
  | { status: "verified"; via: Via }
  | { status: "already_verified" }
  /** Немає що перевіряти: нік не введено. */
  | { status: "no_identity" }
  /** Нік тим часом підтвердив інший профіль. */
  | { status: "taken" }
  | { status: "rate_limited"; retryAfterMinutes: number }
  | Exclude<FindResult, { status: "found" }>;

export type CheckDeps = {
  twitterToken?: string;
  githubToken?: string;
  fetch?: typeof fetch;
};

/** Шукає код у біо (X, GitHub), а для X ще й у власних постах. Нічого не пише. */
export async function findCode(kind: VerifiableKind, value: string, code: string, deps: CheckDeps): Promise<FindResult> {
  const fetchImpl = deps.fetch ?? fetch;
  if (kind === "github") {
    const bio = await readGithubBio(value, deps.githubToken, fetchImpl);
    if (bio.status !== "ok") return bio;
    return containsCode(bio.data, code) ? { status: "found", via: "bio_code" } : { status: "code_missing" };
  }
  if (!deps.twitterToken) return { status: "unavailable" };
  const bio = await readXBio(value, deps.twitterToken, fetchImpl);
  if (bio.status !== "ok") return bio;
  if (containsCode(bio.data, code)) return { status: "found", via: "bio_code" };
  // Пости читаємо, лише якщо в біо коду немає: це ще один запит до 6551.
  const posts = await readXPosts(value, deps.twitterToken, fetchImpl);
  if (posts.status !== "ok") return posts;
  return posts.data.some((text) => containsCode(text, code))
    ? { status: "found", via: "post_code" }
    : { status: "code_missing" };
}

/**
 * Спільний вхід перевірки: без ключа X не витрачаємо спробу (людина не винна,
 * що перевірка не працює), далі ліміт на людину. null = можна читати профіль.
 */
export async function checkGate(
  db: D1Database,
  userId: string,
  kind: VerifiableKind,
  deps: CheckDeps,
): Promise<CheckOutcome | null> {
  if (kind === "x" && !deps.twitterToken) return { status: "unavailable" };
  const verdict = await consume(`verify:${kind}:${userId}`, CHECK_LIMITS, db);
  return verdict.allowed ? null : { status: "rate_limited", retryAfterMinutes: verdict.retryAfterMinutes };
}

/** Перевіряє власний неперевірений нік людини її кодом і позначає перевіреним. */
export async function checkIdentity(
  db: D1Database,
  userId: string,
  kind: VerifiableKind,
  deps: CheckDeps,
): Promise<CheckOutcome> {
  const identity = await getIdentity(db, userId, kind);
  if (!identity) return { status: "no_identity" };
  if (identity.verifiedAt) return { status: "already_verified" };
  const code = identity.verifyCode;
  if (!isVerifyCode(code)) return { status: "no_identity" };

  const blocked = await checkGate(db, userId, kind, deps);
  if (blocked) return blocked;
  const found = await findCode(kind, identity.value, code, deps);
  if (found.status !== "found") return found;
  // Рядок міг зникнути (людина змінила нік в іншій вкладці): тоді не підтверджено.
  if (!(await markVerified(db, userId, kind, identity.value, found.via))) return { status: "no_identity" };
  return { status: "verified", via: found.via };
}

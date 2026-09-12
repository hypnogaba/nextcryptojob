// Перевірка коду в біо (X, GitHub) або в пості (X) для джерела людини.
// Кожна перевірка X коштує балів 6551, тому є ліміт на людину.
import { consume, type Limits } from "@/lib/auth/ratelimit";
import { getIdentity, markVerified } from "@/lib/identity/store";
import { containsCode, isVerifyCode } from "./code";
import { readGithubBio, readXBio, readXPosts } from "./sources";

export type VerifiableKind = "x" | "github";

/** 10 перевірок на годину на людину для кожного джерела окремо. */
export const CHECK_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 10, blockMinutes: 60 };

export type CheckOutcome =
  | { status: "verified"; via: "bio_code" | "post_code" }
  | { status: "already_verified" }
  /** Немає що перевіряти: нік не введено. */
  | { status: "no_identity" }
  /** Профіль прочитали, коду немає. */
  | { status: "code_missing" }
  | { status: "not_found" }
  | { status: "busy" }
  /** Для X без TWITTER_TOKEN або з відхиленим ключем: перевірка не працює. */
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterMinutes: number };

export type CheckDeps = {
  twitterToken?: string;
  githubToken?: string;
  fetch?: typeof fetch;
};

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
  // Без ключа не витрачаємо спробу: людина не винна, що перевірка не працює.
  if (kind === "x" && !deps.twitterToken) return { status: "unavailable" };

  const verdict = await consume(`verify:${kind}:${userId}`, CHECK_LIMITS, db);
  if (!verdict.allowed) return { status: "rate_limited", retryAfterMinutes: verdict.retryAfterMinutes };

  const fetchImpl = deps.fetch ?? fetch;
  let via: "bio_code" | "post_code" | null = null;
  if (kind === "github") {
    const bio = await readGithubBio(identity.value, deps.githubToken, fetchImpl);
    if (bio.status !== "ok") return { status: bio.status };
    if (containsCode(bio.data, code)) via = "bio_code";
  } else {
    const token = deps.twitterToken!;
    const bio = await readXBio(identity.value, token, fetchImpl);
    if (bio.status !== "ok") return { status: bio.status };
    if (containsCode(bio.data, code)) {
      via = "bio_code";
    } else {
      // Пости читаємо, лише якщо в біо коду немає: це ще один запит до 6551.
      const posts = await readXPosts(identity.value, token, fetchImpl);
      if (posts.status !== "ok") return { status: posts.status };
      if (posts.data.some((text) => containsCode(text, code))) via = "post_code";
    }
  }
  if (!via) return { status: "code_missing" };
  // Рядок міг зникнути (людина змінила нік в іншій вкладці): тоді не підтверджено.
  if (!(await markVerified(db, userId, kind, identity.value, via))) return { status: "no_identity" };
  return { status: "verified", via };
}

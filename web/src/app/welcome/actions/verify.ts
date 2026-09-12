"use server";

import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { audit } from "@/lib/audit";
import { appEnv } from "@/lib/db";
import { normalizeGithub, normalizeX } from "@/lib/identity/normalize";
import { getIdentity } from "@/lib/identity/store";
import { checkIdentity, type CheckOutcome, type VerifiableKind } from "@/lib/verify/check";
import { checkClaim, claimCode } from "@/lib/verify/claim";
import { sourceTokens } from "@/lib/verify/tokens";
import { field, GENERIC_ERROR, recordChange, stepContext, withWait, type StepState } from "../flow";

// «Check»: шукає код у біо X чи GitHub (або у власному пості X) і позначає
// джерело перевіреним. З полем claim перевіряє код заявки на нік, який
// тримає інший неперевірений профіль (lib/verify/claim.ts).

const STEP_OF: Record<VerifiableKind, "x" | "sources"> = { x: "x", github: "sources" };

function minutes(n: number): string {
  return n === 1 ? "1 minute" : `${n} minutes`;
}

// Не експортуємо: у файлі "use server" кожен експорт стає публічною дією.
function outcomeMessage(kind: VerifiableKind, value: string, code: string, outcome: CheckOutcome): FormMessage {
  const name = kind === "x" ? "X" : "GitHub";
  switch (outcome.status) {
    case "code_missing":
      return {
        tone: "error",
        text:
          kind === "x"
            ? `We did not find ${code} in the bio or your own last 20 posts of @${value}. Retweets do not count. A new post can take a minute to show up. Try again soon.`
            : `We did not find ${code} in the bio of github.com/${value}. Save your GitHub profile and try again.`,
      };
    case "not_found":
      return { tone: "error", text: `${name} has no account called ${value}. Check the spelling.` };
    case "busy":
      return {
        tone: "error",
        text:
          kind === "x"
            ? "We could not read this X profile right now. Check the handle is right and try again in a minute."
            : "GitHub did not answer right now. Try again in a minute.",
      };
    case "source_limited":
      return { tone: "error", text: "GitHub is busy. Try again in a few minutes." };
    case "unavailable":
      return { tone: "info", text: `${name} verification is not available yet.` };
    case "rate_limited":
      return { tone: "error", text: `Too many checks. Try again in ${minutes(outcome.retryAfterMinutes)}.` };
    case "taken":
      return { tone: "error", text: `This ${name} account is already linked to another profile.` };
    case "no_identity":
      return { tone: "error", text: `Add your ${name} first.` };
    default:
      return GENERIC_ERROR;
  }
}

export async function checkCodeAction(_prev: StepState, form: FormData): Promise<StepState> {
  const kind: VerifiableKind = field(form, "kind") === "github" ? "github" : "x";
  const ctx = await stepContext(STEP_OF[kind]);
  const claimRaw = field(form, "claim");
  const claim = claimRaw ? (kind === "x" ? normalizeX(claimRaw) : normalizeGithub(claimRaw)) : null;
  if (claim && !claim.ok) return { message: GENERIC_ERROR };
  const secret = appEnv().SESSION_SECRET;

  let outcome: CheckOutcome;
  let value = "";
  let code = "";
  try {
    if (claim?.ok) {
      if (!secret) return { message: { tone: "info", text: `${kind === "x" ? "X" : "GitHub"} verification is not available yet.` } };
      value = claim.value;
      code = await claimCode(secret, kind, value, ctx.user.id);
      outcome = await checkClaim(ctx.d, ctx.user.id, kind, value, { ...sourceTokens(), secret });
    } else {
      const identity = await getIdentity(ctx.d, ctx.user.id, kind);
      value = identity?.value ?? "";
      code = identity?.verifyCode ?? "";
      outcome = await checkIdentity(ctx.d, ctx.user.id, kind, sourceTokens());
    }
  } catch (err) {
    console.error("verification failed:", err instanceof Error ? err.message : String(err));
    return { message: GENERIC_ERROR };
  }

  if (outcome.status === "verified") {
    await audit(ctx.user.id, claim ? "identity.claim" : "identity.verify", ctx.user.id, { kind, via: outcome.via });
    const wait = await recordChange(ctx, "verify");
    redirect(withWait(`/welcome?step=${STEP_OF[kind]}`, wait));
  }
  if (outcome.status === "already_verified") redirect(`/welcome?step=${STEP_OF[kind]}`);
  return { message: outcomeMessage(kind, value, code, outcome) };
}

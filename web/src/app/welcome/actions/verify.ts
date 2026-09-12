"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { getIdentity } from "@/lib/identity/store";
import { checkIdentity, type CheckOutcome, type VerifiableKind } from "@/lib/verify/check";
import { sourceTokens } from "@/lib/verify/tokens";
import { field, GENERIC_ERROR, stepContext, type StepState } from "../flow";
import type { FormMessage } from "@/components/form/form-message";

// «Check»: шукає код у біо X чи GitHub (або в пості X) і позначає джерело перевіреним.

const STEP_OF: Record<VerifiableKind, "x" | "sources"> = { x: "x", github: "sources" };

function minutes(n: number): string {
  return n === 1 ? "1 minute" : `${n} minutes`;
}

function outcomeMessage(kind: VerifiableKind, value: string, code: string, outcome: CheckOutcome): FormMessage {
  const name = kind === "x" ? "X" : "GitHub";
  switch (outcome.status) {
    case "code_missing":
      return {
        tone: "error",
        text:
          kind === "x"
            ? `We did not find ${code} in the bio or the last 20 posts of @${value}. A new post can take a minute to show up. Try again soon.`
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
    case "unavailable":
      return { tone: "info", text: `${name} verification is not available yet.` };
    case "rate_limited":
      return { tone: "error", text: `Too many checks. Try again in ${minutes(outcome.retryAfterMinutes)}.` };
    case "no_identity":
      return { tone: "error", text: `Add your ${name} first.` };
    default:
      return GENERIC_ERROR;
  }
}

export async function checkCodeAction(_prev: StepState, form: FormData): Promise<StepState> {
  const kind: VerifiableKind = field(form, "kind") === "github" ? "github" : "x";
  const ctx = await stepContext(STEP_OF[kind]);
  const identity = await getIdentity(ctx.d, ctx.user.id, kind);

  let outcome: CheckOutcome;
  try {
    outcome = await checkIdentity(ctx.d, ctx.user.id, kind, sourceTokens());
  } catch (err) {
    console.error("checkIdentity failed:", err instanceof Error ? err.message : String(err));
    return { message: GENERIC_ERROR };
  }
  if (outcome.status === "verified") {
    await audit(ctx.user.id, "identity.verify", ctx.user.id, { kind, via: outcome.via });
  }
  if (outcome.status === "verified" || outcome.status === "already_verified") {
    redirect(`/welcome?step=${STEP_OF[kind]}`);
  }
  return { message: outcomeMessage(kind, identity?.value ?? "", identity?.verifyCode ?? "", outcome) };
}

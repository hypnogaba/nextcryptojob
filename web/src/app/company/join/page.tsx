import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { findInvite } from "@/lib/crm/team";
import { db } from "@/lib/db";
import { acceptInviteAction } from "./actions";

export const metadata: Metadata = { title: "Join a team", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const ERRORS: Record<string, string> = {
  invite_invalid: "This invite link is not valid or was already used. Ask the owner for a new one.",
  invite_expired: "This invite has expired. Ask the owner to send a new one.",
  invite_email_mismatch: "This invite was sent to another email address.",
  email_required: "Sign in with the email this invite was sent to.",
  seat_limit: "This team is full. Ask the owner to free a seat, then open the link again.",
  company_not_active: "This company account is not active.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto grid max-w-md gap-4 px-[clamp(16px,4vw,56px)] pt-16 pb-24 sm:pt-24">
      <h1 className="display text-title break-words">{title}</h1>
      {children}
    </section>
  );
}

/**
 * Запрошення в команду (специфікація 6.3). GET лише показує; прийняти можна
 * кнопкою (POST) і лише з сесією людини, чия підтверджена пошта = пошта запрошення.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = first(params.t) ?? "";
  const error = first(params.error);
  const invite = await findInvite(db(), token);

  if (invite.state === "invalid") {
    return (
      <Shell title="Invite not valid">
        <p className="text-ink-muted">{ERRORS.invite_invalid}</p>
      </Shell>
    );
  }
  if (invite.state === "expired") {
    return (
      <Shell title="Invite expired">
        <p className="text-ink-muted">
          The invite to {invite.companyName} has expired. Ask the owner to send a new one.
        </p>
      </Shell>
    );
  }

  const user = await currentUser();
  const title = `Join ${invite.companyName}`;
  const intro = (
    <p className="text-ink-muted">
      {invite.companyName} invited {invite.maskedEmail} to their team on NextCryptoJob. The invite expires on{" "}
      {DATE.format(invite.expiresAt)}.
    </p>
  );

  if (!user) {
    return (
      <Shell title={title}>
        {intro}
        <p className="text-ink">Sign in with {invite.maskedEmail} to accept. Then open this link again.</p>
        <Button asChild className="h-11 w-full px-5 text-base sm:w-fit">
          <Link href="/login">Sign in</Link>
        </Button>
      </Shell>
    );
  }

  const matches = user.email !== null && user.email.toLowerCase() === invite.email;
  if (!matches) {
    return (
      <Shell title={title}>
        {intro}
        <p role="alert" className="text-ink">
          {user.email
            ? `You are signed in as ${user.email}. This invite was sent to ${invite.maskedEmail}. Sign out and sign in with that email to accept it.`
            : `You signed in with Telegram. Sign out and sign in with ${invite.maskedEmail} to accept this invite.`}
        </p>
        <SignOutButton />
      </Shell>
    );
  }

  if (invite.companyStatus !== "active") {
    return (
      <Shell title={title}>
        <p className="text-ink-muted">{ERRORS.company_not_active}</p>
      </Shell>
    );
  }

  return (
    <Shell title={title}>
      {intro}
      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error] ?? "Something went wrong. Try again."}
        </p>
      ) : null}
      <form action={acceptInviteAction}>
        <input type="hidden" name="t" value={token} />
        <SubmitButton pendingLabel="Joining..." className="h-11 w-full px-5 text-base sm:w-fit">
          Join {invite.companyName}
        </SubmitButton>
      </form>
    </Shell>
  );
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { HINT } from "@/components/form/styles";
import { currentUser } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/billing/origin";
import { loadIntroForCandidate, type CandidateIntroView } from "@/lib/crm/intros";
import { ANSWER_TEXT, introRequestLines } from "@/lib/crm/notify";
import { db } from "@/lib/db";
import { isId } from "@/lib/ids";
import { IntroAnswerForm } from "./answer-form";

/**
 * Відповідь кандидата на запит знайомства (специфікація CRM, 5.5, макет W5).
 * GET лише показує: що просять і що САМЕ побачить компанія після «так».
 * Відповідь іде формою (POST, server action). Посилання з листа несе токен
 * `?t=`; із сесією кандидата токен не потрібен. Токен не йде далі адресою:
 * referrer вимкнено.
 */

export const metadata: Metadata = {
  title: "Intro request",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-2xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-14">
      <section className="grid gap-5 rounded-xl border border-line bg-surface p-4 sm:p-6">{children}</section>
    </div>
  );
}

function Closed({ view }: { view: Exclude<CandidateIntroView, { state: "pending" }> }) {
  const text =
    view.state === "withdrawn"
      ? ANSWER_TEXT.withdrawn
      : view.state === "expired"
        ? ANSWER_TEXT.expired
        : view.state === "answered"
          ? ANSWER_TEXT.alreadyAnswered
          : ANSWER_TEXT.invalid;
  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Intro request</h1>
      <p className="text-base text-ink">{text}</p>
      {view.state === "invalid" ? (
        <p className={HINT}>
          If you have a NextCryptoJob account,{" "}
          <Link href="/login" className="font-medium text-brand underline underline-offset-4">
            sign in
          </Link>{" "}
          and open this link again.
        </p>
      ) : null}
    </Shell>
  );
}

export default async function IntroPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const token = first((await searchParams).t);
  const user = await currentUser();
  const view: CandidateIntroView = isId("int", id)
    ? await loadIntroForCandidate(db(), id, { token, sessionUserId: user?.id ?? null })
    : { state: "invalid" };
  if (view.state !== "pending") return <Closed view={view} />;

  const { details, contact } = view;
  const origin = requestOrigin(await headers());
  const [headline, , quote, , ...facts] = introRequestLines(details, origin);
  const company = details.companyName;

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{headline.text}</h1>
      <blockquote className="border-l-2 border-brand pl-4 text-base whitespace-pre-line text-ink">
        {quote.text}
      </blockquote>
      <ul className="grid gap-1 text-sm text-ink">
        {facts.map((line) =>
          line.link && details.jobId ? (
            <li key={line.text}>
              Job:{" "}
              <Link href={`/jobs/${details.jobId}`} className="font-medium text-brand underline underline-offset-4">
                {details.jobTitle ?? "Open job"}
              </Link>
            </li>
          ) : (
            <li key={line.text}>{line.text}</li>
          ),
        )}
      </ul>
      {view.about ? (
        <p className={HINT}>
          About {company}: {view.about}
        </p>
      ) : null}

      <IntroAnswerForm
        introId={details.introId}
        token={view.auth === "token" ? token : null}
        acceptLabel={contact?.kind === "email" ? "Accept and share my email" : "Accept and share my Telegram"}
        canAccept={contact !== null}
        preview={
          <div className="grid gap-2 rounded-md border border-line bg-wash p-4">
            <p className="text-base text-ink">
              {contact?.kind === "telegram" ? (
                <>
                  If you accept, {company} will see your Telegram handle <strong>{contact.shown}</strong>. They will not
                  see your email or wallets.
                </>
              ) : contact?.kind === "email" ? (
                <>
                  If you accept, {company} will see your email address <strong>{contact.shown}</strong>. They will not
                  see your wallets.
                </>
              ) : (
                ANSWER_TEXT.noContact
              )}
            </p>
          </div>
        }
      />
    </Shell>
  );
}

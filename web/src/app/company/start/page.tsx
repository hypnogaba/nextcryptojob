import type { Metadata } from "next";
import { getSettings } from "@/lib/admin/settings";
import { requireUser } from "@/lib/auth/session";
import { listMemberships } from "@/lib/crm/company";
import { COUNTRIES } from "@/lib/crm/countries";
import { db } from "@/lib/db";
import { switchCompanyAction } from "../(crm)/actions";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Create a company account", robots: { index: false } };

/** Реєстрація компанії або агенції (специфікація 6.1). Лише після входу. */
export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const agency = params.kind === "agency";
  const [all, settings] = await Promise.all([listMemberships(db(), user.id), getSettings(db())]);
  const memberships = all.filter((m) => m.status !== "closed");

  return (
    <section className="mx-auto grid max-w-xl gap-8 px-[clamp(16px,4vw,56px)] pt-10 pb-20 sm:pt-16">
      <div className="grid gap-3">
        <h1 className="display text-title">
          {agency ? "Apply as a recruiting agency" : "Create a company account"}
        </h1>
        <p className="text-ink-muted">
          You will be the owner. You can invite your team after this step.
          {user.email ? null : " Tip: sign in with your work email so we can verify your company domain."}
        </p>
      </div>

      {memberships.length > 0 ? (
        <div className="grid gap-2 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm text-ink-muted">You already have access to:</p>
          <ul className="grid gap-1">
            {memberships.map((m) => (
              <li key={m.companyId}>
                <form action={switchCompanyAction}>
                  <input type="hidden" name="company_id" value={m.companyId} />
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-2 text-left hover:bg-wash"
                  >
                    <span className="font-semibold text-ink">{m.name}</span>
                    <span className="text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4">Open</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {settings.company_signups_open ? (
        <StartForm countries={COUNTRIES} agency={agency} />
      ) : (
        <p role="status" data-signups="closed" className="rounded-xl border border-line-strong bg-surface p-4 text-ink">
          New company accounts are closed for now. Teams that already have an account keep working, and invites still
          open. Check back soon.
        </p>
      )}
    </section>
  );
}

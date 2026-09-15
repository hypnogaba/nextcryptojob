import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { COMPANY_SWITCHED_TEXT, LAST_OWNER_TEXT } from "@/lib/crm/company";
import { WEB_BURST_TEXT } from "@/lib/crm/context";
import { can } from "@/lib/crm/permissions";
import { loadTeam } from "@/lib/crm/team";
import { fromSqlTime } from "@/lib/time";
import { crmPage } from "../crm";
import { LeaveTeam } from "@/components/crm/leave-team";
import { H2, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { DANGER_SUMMARY } from "../jobs/parts";
import { changeRoleAction, removeMemberAction, revokeInviteAction } from "./actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Team", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const DONE: Record<string, string> = {
  made_owner: "Done. They are now an owner.",
  made_member: "Done. They are now a member.",
  removed: "Removed. They lose access on their next page load.",
  invite_canceled: "Invite canceled. The link no longer works.",
};

const ERRORS: Record<string, string> = {
  last_owner: LAST_OWNER_TEXT,
  not_found: "This person is not on your team.",
  forbidden: "Only the company owner can manage the team.",
  company_not_active: "This company account is not active.",
  validation_failed: "Use Leave the team to leave this company.",
  company_switched: COMPANY_SWITCHED_TEXT,
  unauthorized: "Sign in again to continue.",
  rate_limited: WEB_BURST_TEXT,
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function date(sql: string | null): string {
  return sql ? DATE.format(fromSqlTime(sql)) : "Never";
}

/** Команда (специфікація 6.3, 10.2): таблиця, "Invite teammate", "Make owner", "Remove", "Leave the team". */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { ctx, role, company } = await crmPage("team");
  const params = await searchParams;
  const team = await loadTeam(ctx);
  const isOwner = can(role, "team.manage");
  const done = first(params.done);
  const error = first(params.error);
  const seatsLeft = Math.max(0, team.seats.limit - team.seats.used);

  return (
    <div className={`${PAGE} max-w-7xl *:max-w-3xl`}>
      <PageTitle aside={`${team.seats.used} of ${team.seats.limit} seats used`}>Team</PageTitle>

      {done && DONE[done] ? (
        <Notice tone="success">{DONE[done]}</Notice>
      ) : null}
      {error ? (
        <Notice tone="error">{ERRORS[error] ?? "Something went wrong. Try again."}</Notice>
      ) : null}

      {isOwner ? (
        <section aria-labelledby="invite-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
          <h2 id="invite-title" className={H2}>
            Invite teammate
          </h2>
          <InviteForm seatsLeft={seatsLeft} companyId={company.id} />
        </section>
      ) : null}

      <section aria-labelledby="people-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
        <h2 id="people-title" className={H2}>
          People at {company.name}
        </h2>
        <ul className="grid gap-3">
          {team.members.map((m) => (
            <li key={m.userId} className="grid gap-2 border-b border-line pb-3 last:border-b-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="grid gap-0.5">
                <p className="font-semibold break-all text-ink">
                  {m.label}
                  {m.isMe ? <span className="font-normal text-ink-muted"> (you)</span> : null}
                </p>
                <p className="text-sm text-ink-muted">
                  {m.role === "owner" ? "Owner" : "Member"}. Joined {date(m.joinedAt)}. Last seen {date(m.lastSeenAt)}.
                </p>
              </div>
              {isOwner && !m.isMe ? (
                <div className="flex flex-wrap gap-2">
                  <form action={changeRoleAction}>
                    <input type="hidden" name="company_id" value={company.id} />
                    <input type="hidden" name="user_id" value={m.userId} />
                    <input type="hidden" name="role" value={m.role === "owner" ? "member" : "owner"} />
                    <Button type="submit" variant="outline" className="h-11 px-3 text-sm">
                      {m.role === "owner" ? "Make member" : "Make owner"}
                    </Button>
                  </form>
                  <details className="relative">
                    <summary className={DANGER_SUMMARY}>
                      Remove
                    </summary>
                    <form action={removeMemberAction} className="absolute right-0 z-10 mt-1 grid w-64 gap-2 rounded-lg border border-line bg-surface p-3 shadow-lift">
                      <input type="hidden" name="company_id" value={company.id} />
                      <input type="hidden" name="user_id" value={m.userId} />
                      <p className="text-sm text-ink">Remove {m.label}? Their notes stay, signed Former member.</p>
                      <Button type="submit" variant="destructive" className="h-11 px-3 text-sm">
                        Remove from team
                      </Button>
                    </form>
                  </details>
                </div>
              ) : null}
              {isOwner && m.isMe && m.role === "owner" ? (
                <form action={changeRoleAction}>
                  <input type="hidden" name="company_id" value={company.id} />
                  <input type="hidden" name="user_id" value={m.userId} />
                  <input type="hidden" name="role" value="member" />
                  <Button type="submit" variant="outline" className="h-11 px-3 text-sm" disabled={team.owners <= 1}>
                    Step down to member
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {team.invites.length > 0 ? (
        <section aria-labelledby="invites-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
          <h2 id="invites-title" className={H2}>
            Pending invites
          </h2>
          <ul className="grid gap-3">
            {team.invites.map((i) => (
              <li key={i.id} className="grid gap-2 border-b border-line pb-3 last:border-b-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="grid gap-0.5">
                  <p className="font-semibold break-all text-ink">{i.email}</p>
                  <p className="text-sm text-ink-muted">
                    {i.expired ? `Expired on ${DATE.format(i.expiresAt)}. Invite again to send a new link.` : `Expires on ${DATE.format(i.expiresAt)}.`}
                  </p>
                </div>
                {isOwner ? (
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="company_id" value={company.id} />
                    <input type="hidden" name="invite_id" value={i.id} />
                    <Button type="submit" variant="outline" className="h-11 px-3 text-sm">
                      Cancel invite
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <LeaveTeam companyId={company.id} companyName={company.name} blocked={role === "owner" && team.owners <= 1} from="team" />
    </div>
  );
}

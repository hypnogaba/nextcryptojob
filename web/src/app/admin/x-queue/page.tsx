import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { Button } from "@/components/ui/button";
import { listRecentXPosts, listXQueue, type AdminJobError } from "@/lib/admin/jobs";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { markXPostedAction, skipXPostAction } from "../jobs/actions";
import { CopyButton } from "./copy-button";

export const metadata: Metadata = { title: "X queue", robots: { index: false } };

/**
 * Адмінка: черга постів для X-акаунта проєкту (специфікація CRM 5.6 і 12). Компанія
 * ставить галочку "Post on @nextcryptojob (reviewed by our team)"; тут текст за шаблоном,
 * "Copy", "Mark as posted" з посиланням на пост і "Skip". Лише живі вакансії: закрита чи
 * прихована зникає з черги сама.
 */

const ERRORS: Record<AdminJobError, string> = {
  not_admin: "Only admins can do this.",
  not_found: "This job is no longer in the queue.",
  bad_url: "Paste the https://x.com/.../status/... link of the post.",
};

const DONE: Record<string, string> = { posted: "is marked as posted", skipped: "is skipped" };

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function when(sql: string | null): string {
  return sql ? `${WHEN.format(fromSqlTime(sql))} UTC` : "";
}

export default async function XQueuePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const [queue, recent] = await Promise.all([listXQueue(db()), listRecentXPosts(db())]);
  const error = first(params.error);
  const done = first(params.done);

  return (
    <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <AdminNav current="/admin/x-queue" />
      <h1 className="text-3xl font-semibold tracking-tight">X queue</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Live company jobs whose company asked for a post on @nextcryptojob. Copy the text, post it on X by hand, then paste the
        link of the post. Skip what should not go out.
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {ERRORS[error as AdminJobError]}
        </p>
      ) : null}
      {done && done in DONE ? (
        <p role="status" className="mt-6 rounded-md border border-line bg-brand-soft px-4 py-3 text-sm">
          Job {first(params.job)} {DONE[done]}.
        </p>
      ) : null}

      <h2 className="mt-10 text-xl font-semibold">Waiting ({queue.length})</h2>
      {queue.length === 0 ? (
        <p className="mt-4 text-ink-muted">Nothing to post.</p>
      ) : (
        <ul className="mt-4 grid gap-4">
          {queue.map((row) => (
            <li key={row.id} className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4" data-job={row.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                <a href={`/jobs/${row.id}`} target="_blank" rel="noopener noreferrer" className="min-w-0 font-medium wrap-anywhere text-brand hover:underline">
                  {row.companyName}: {row.title}
                </a>
                <span className="text-xs text-ink-muted">Queued {when(row.queuedAt)}</span>
              </div>
              <p className="rounded-md border border-line bg-wash px-3 py-2 font-mono text-sm wrap-anywhere text-ink select-all">{row.text}</p>
              <p className="text-xs text-ink-muted">{row.text.length} of 280 characters</p>
              <div className="flex flex-wrap items-end gap-2">
                <CopyButton text={row.text} />
                <form action={markXPostedAction} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                  <input type="hidden" name="job_id" value={row.id} />
                  <label className="grid min-w-0 flex-1 gap-1 text-sm">
                    <span className="text-ink-muted">Link of the post</span>
                    <input
                      type="url"
                      name="url"
                      required
                      placeholder="https://x.com/nextcryptojob/status/..."
                      className="h-10 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2"
                    />
                  </label>
                  <Button type="submit" className="h-10 px-3">
                    Mark as posted
                  </Button>
                </form>
                <form action={skipXPostAction}>
                  <input type="hidden" name="job_id" value={row.id} />
                  <Button type="submit" variant="ghost" className="h-10 px-3">
                    Skip
                  </Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-12 text-xl font-semibold">Recently posted</h2>
      {recent.length === 0 ? (
        <p className="mt-4 text-ink-muted">No posts yet.</p>
      ) : (
        <ul className="mt-4 grid gap-2 text-sm">
          {recent.map((row) => (
            <li key={row.id} className="flex flex-wrap gap-x-3 gap-y-1">
              <span className="min-w-0 wrap-anywhere text-ink">
                {row.companyName}: {row.title}
              </span>
              {row.url ? (
                <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  View post
                </a>
              ) : null}
              <span className="text-ink-muted">{when(row.postedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

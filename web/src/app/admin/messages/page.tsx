import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { Button } from "@/components/ui/button";
import { currentAdmin } from "@/lib/auth/admin";
import { listContactMessages } from "@/lib/contact";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { setAnsweredAction } from "./actions";

export const metadata: Metadata = { title: "Messages", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

const ERRORS: Record<string, string> = {
  not_admin: "Only admins can do this.",
  not_found: "Message not found.",
};

const DONE: Record<string, string> = {
  answered: "Marked answered.",
  reopened: "Marked unanswered.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const error = first(params.error);
  const done = first(params.done);
  const list = await listContactMessages(db());

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-5xl">
      <AdminNav current="/admin/messages" />
      <h1 className="display text-title">Messages</h1>
      <p className="mt-2 text-sm text-ink-muted">Every message from /contact. Reply by email, then mark it answered.</p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error]}
        </p>
      ) : null}
      {done && done in DONE ? (
        <p role="status" className="mt-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
          {DONE[done]}
        </p>
      ) : null}

      {!list.available ? (
        <p className="mt-8 text-sm text-ink-muted">{list.error}</p>
      ) : list.messages.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">No messages yet.</p>
      ) : (
        <div className={`mt-8 ${BOARD}`}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH_TIGHT}>When</th>
                <th className={TH_TIGHT}>Email</th>
                <th className={TH_TIGHT}>Topic</th>
                <th className={TH_TIGHT}>Message</th>
                <th className={TH_TIGHT}>Status</th>
                <th className={TH_TIGHT}></th>
              </tr>
            </thead>
            <tbody>
              {list.messages.map((m) => (
                <tr key={m.id} className={TR}>
                  <td className={TD_TIGHT}>{DATE.format(fromSqlTime(m.createdAt))}</td>
                  <td className={TD_TIGHT}>
                    <a href={`mailto:${m.email}`} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
                      {m.email}
                    </a>
                  </td>
                  <td className={`${TD_TIGHT} capitalize`}>{m.topic}</td>
                  <td className={`${TD_TIGHT} max-w-md whitespace-pre-line break-words`}>{m.message}</td>
                  <td className={TD_TIGHT}>{m.answeredAt ? "Answered" : "Waiting"}</td>
                  <td className={TD_TIGHT}>
                    <form action={setAnsweredAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="answered" value={m.answeredAt ? "0" : "1"} />
                      <Button type="submit" variant="outline" size="sm">
                        {m.answeredAt ? "Mark unanswered" : "Mark answered"}
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

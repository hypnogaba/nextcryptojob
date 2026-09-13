import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { xPostUrlOf } from "@/lib/admin/jobs";
import { createSession } from "@/lib/auth/session";
import { newId } from "@/lib/ids";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import XQueuePage from "../x-queue/page";
import { hideJobAction, markXPostedAction, skipXPostAction, unhideJobAction } from "./actions";
import AdminJobsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

/**
 * Адмінка вакансій компаній (специфікація 12): "Hide" / "Unhide" і черга X ("Copy",
 * "Mark as posted", "Skip"). Лише адмін, що ввійшов поштою; кожна дія пише audit_log.
 */

let company: string;

beforeEach(() => {
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  run(raw, "INSERT INTO users (id, email) VALUES ('boss', 'boss@example.com'), ('ada', 'ada@example.com')");
  company = addCompany(raw, { name: "Acme Labs" });
  addSubscription(raw, company);
});

function addJob(o: { x?: "none" | "queued" | "posted" | "skipped"; status?: string; title?: string } = {}): string {
  const id = newId("job");
  run(
    harness.raw,
    `INSERT INTO company_jobs (id, company_id, status, title, roles, apply_url, created_via, published_at, expires_at,
                               x_post_state, x_post_text, x_queued_at)
     VALUES (?, ?, ?, ?, '["engineer"]', 'https://acme.io/jobs', 'web', datetime('now'), datetime('now', '+60 days'), ?, ?, datetime('now'))`,
    id,
    company,
    o.status ?? "open",
    o.title ?? "Solidity engineer",
    o.x ?? "none",
    o.x && o.x !== "none" ? `Acme Labs is hiring: ${o.title ?? "Solidity engineer"} (Remote). Apply: nextcryptojob.xyz/jobs/${id}` : null,
  );
  return id;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

const sp = (p: Record<string, string> = {}) => ({ searchParams: Promise.resolve(p) });
const html = async (node: Promise<React.ReactNode>) => renderToStaticMarkup(await node).replaceAll("&amp;", "&");

describe("/admin/jobs", () => {
  it("is not found for someone who is not an admin, and its actions refuse them", async () => {
    const id = addJob();
    await createSession("ada", "email");
    await expect(AdminJobsPage(sp())).rejects.toBeInstanceOf(NotFoundCalled);
    await expect(XQueuePage(sp())).rejects.toBeInstanceOf(NotFoundCalled);
    expect(await redirectOf(hideJobAction(form({ job_id: id })))).toBe("/admin/jobs?error=not_admin");
    expect(await redirectOf(markXPostedAction(form({ job_id: id, url: "https://x.com/a/status/1" })))).toBe("/admin/x-queue?error=not_admin");
    expect(rows("SELECT hidden_by_admin_at FROM company_jobs")).toEqual([{ hidden_by_admin_at: null }]);
  });

  it("Hide takes a job out of company_jobs_live at once; Unhide brings it back; each writes the audit log once", async () => {
    await createSession("boss", "email");
    const id = addJob();
    const page = await html(AdminJobsPage(sp()));
    expect(page).toContain("Solidity engineer");
    expect(page).toContain(">Live<");
    expect(page).toContain(">Hide<");

    expect(await redirectOf(hideJobAction(form({ job_id: id })))).toBe(`/admin/jobs?done=hidden&job=${id}`);
    expect(rows("SELECT id FROM company_jobs_live")).toEqual([]);
    expect(await redirectOf(hideJobAction(form({ job_id: id })))).toBe(`/admin/jobs?error=not_found&job=${id}`);
    const hidden = await html(AdminJobsPage(sp({ done: "hidden", job: id })));
    expect(hidden).toContain(`Job ${id} is hidden.`);
    expect(hidden).toContain("Hidden since");
    expect(hidden).toContain(">Unhide<");

    expect(await redirectOf(unhideJobAction(form({ job_id: id })))).toBe(`/admin/jobs?done=unhidden&job=${id}`);
    expect(rows("SELECT id FROM company_jobs_live")).toEqual([{ id }]);
    const log = rows<{ actor: string; action: string; meta_json: string }>("SELECT actor, action, meta_json FROM audit_log ORDER BY id");
    expect(log.map((l) => [l.actor, l.action])).toEqual([
      ["admin:boss", "job.hide"],
      ["admin:boss", "job.unhide"],
    ]);
    expect(JSON.parse(log[0].meta_json)).toMatchObject({ job_id: id, company_id: company });
  });
});

describe("/admin/x-queue", () => {
  it("lists live queued jobs with their text; closed or hidden ones leave the queue", async () => {
    await createSession("boss", "email");
    const live = addJob({ x: "queued", title: "Rust engineer" });
    addJob({ x: "queued", status: "draft", title: "Draft role" });
    const hidden = addJob({ x: "queued", title: "Hidden role" });
    run(harness.raw, "UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = ?", hidden);
    addJob({ x: "none", title: "No post role" });

    const page = await html(XQueuePage(sp()));
    expect(page).toContain("Waiting (1)");
    expect(page).toContain(`Acme Labs is hiring: Rust engineer (Remote). Apply: nextcryptojob.xyz/jobs/${live}`);
    expect(page).toContain(">Copy<");
    expect(page).not.toContain("Draft role");
    expect(page).not.toContain("Hidden role");
    expect(page).not.toContain("No post role");
  });

  it("Mark as posted keeps the link of the post; a wrong link is refused; Skip takes the job off the queue", async () => {
    await createSession("boss", "email");
    const a = addJob({ x: "queued" });
    const b = addJob({ x: "queued", title: "Growth lead" });

    expect(await redirectOf(markXPostedAction(form({ job_id: a, url: "https://example.com/post" })))).toBe(
      `/admin/x-queue?error=bad_url&job=${a}`,
    );
    expect(await redirectOf(markXPostedAction(form({ job_id: a, url: "https://twitter.com/nextcryptojob/status/1834567890123/" })))).toBe(
      `/admin/x-queue?done=posted&job=${a}`,
    );
    expect(rows("SELECT x_post_state, x_post_url FROM company_jobs WHERE id = ?", a)).toEqual([
      { x_post_state: "posted", x_post_url: "https://x.com/nextcryptojob/status/1834567890123" },
    ]);
    // Уже опубліковано: вдруге не можна ні позначити, ні пропустити.
    expect(await redirectOf(skipXPostAction(form({ job_id: a })))).toBe(`/admin/x-queue?error=not_found&job=${a}`);

    expect(await redirectOf(skipXPostAction(form({ job_id: b })))).toBe(`/admin/x-queue?done=skipped&job=${b}`);
    expect(rows("SELECT x_post_state FROM company_jobs WHERE id = ?", b)).toEqual([{ x_post_state: "skipped" }]);

    const page = await html(XQueuePage(sp({ done: "posted", job: a })));
    expect(page).toContain("Waiting (0)");
    expect(page).toContain("Recently posted");
    expect(page).toContain('href="https://x.com/nextcryptojob/status/1834567890123"');
    expect(rows<{ action: string }>("SELECT action FROM audit_log ORDER BY id").map((r) => r.action)).toEqual(["x.posted", "x.skipped"]);
  });

  it("accepts only links to a post on x.com or twitter.com", () => {
    expect(xPostUrlOf("https://x.com/nextcryptojob/status/123")).toBe("https://x.com/nextcryptojob/status/123");
    expect(xPostUrlOf("https://mobile.twitter.com/nextcryptojob/status/123")).toBe("https://x.com/nextcryptojob/status/123");
    for (const bad of ["http://x.com/a/status/1", "https://x.com/nextcryptojob", "https://evil.com/a/status/1", "javascript:alert(1)", ""]) {
      expect(xPostUrlOf(bad)).toBeNull();
    }
  });
});

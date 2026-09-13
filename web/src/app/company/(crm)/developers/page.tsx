import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { TABLE, TD, TH, TR } from "@/components/board";
import { CARD, EmptyState, H2, LINK, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { readAction } from "@/lib/crm/actions";
import { COMPANY_SWITCHED_TEXT, memberLabels } from "@/lib/crm/company";
import { WEB_BURST_TEXT } from "@/lib/crm/context";
import { listApiKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import type { Webhook } from "@/lib/crm/types";
import { recentDeliveries, webhookQueueCounts, WEBHOOK_EVENTS } from "@/lib/crm/webhooks";
import { siteOrigin } from "@/lib/site";
import { fromSqlTime } from "@/lib/time";
import { crmPage } from "../crm";
import { revokeKeyAction } from "./actions";
import { CreateKeyForm, WebhookForm } from "./developer-forms";

export const metadata: Metadata = { title: "Developers", robots: { index: false } };

const TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
const at = (sql: string) => `${TIME.format(fromSqlTime(sql))} UTC`;

const ERRORS: Record<string, string> = {
  not_found: "This API key does not exist or is already revoked.",
  forbidden: "Only the company owner can manage API keys.",
  company_switched: COMPANY_SWITCHED_TEXT,
  unauthorized: "Sign in again to continue.",
  rate_limited: WEB_BURST_TEXT,
};

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`${CARD} grid scroll-mt-6 gap-4 p-4 sm:p-6`}>
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className={H2}>
          {title}
        </h2>
        {intro ? <div className={HINT}>{intro}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-wash">
      <pre className="p-4 font-mono text-xs leading-relaxed text-ink">
        <code>{children}</code>
      </pre>
    </div>
  );
}

const VERIFY_SNIPPET = `// Node 18+ or a Worker. Read the raw body before parsing it.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  return parts
    .filter(([k]) => k === "v1")
    .some(([, v]) => {
      const got = Buffer.from(v, "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}`;

/**
 * Developers (специфікація 10.2, W6): ключі API (лише власник; ключ видно раз),
 * вебхук (власник змінює, член бачить), журнал доставок, використання, MCP і
 * посилання на документацію.
 */
export default async function DevelopersPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
} = {}) {
  const { ctx, role, company } = await crmPage("developers");
  const params = (await searchParams) ?? {};
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = one(params.error);
  const done = one(params.done);

  const isOwner = can(role, "api_keys.create");
  const canWriteHook = can(role, "webhook.write");
  const configured = Boolean(ctx.env.WEBHOOK_SIGNING_KEY?.trim());
  const [hook, keys, deliveries, queue, usage] = await Promise.all([
    readAction("get_webhook", {}, ctx) as Promise<Webhook>,
    isOwner ? listApiKeys(ctx) : Promise.resolve([]),
    recentDeliveries(ctx.db, company.id, 20),
    webhookQueueCounts(ctx.db, company.id),
    readAction("get_usage", {}, ctx) as Promise<{ totals: { calls: number; x402_usd: string }; days: { action: string; calls: number; x402_usd: string }[] }>,
  ]);
  const creators = await memberLabels(
    ctx.db,
    company.id,
    keys.map((k) => k.created_by_user_id ?? ""),
  );
  const perAction = new Map<string, { calls: number; cents: number }>();
  for (const d of usage.days) {
    const row = perAction.get(d.action) ?? { calls: 0, cents: 0 };
    row.calls += d.calls;
    row.cents += Math.round(Number(d.x402_usd) * 100);
    perAction.set(d.action, row);
  }
  const origin = siteOrigin(ctx.env);
  const readOnlyApi = company.access !== "subscription";

  const mcpConfig = JSON.stringify(
    { mcpServers: { nextcryptojob: { url: `${origin}/mcp`, headers: { Authorization: "Bearer ncj_live_..." } } } },
    null,
    2,
  );
  const curl = [`curl ${origin}/api/v1/me \\`, '  -H "Authorization: Bearer $NCJ_API_KEY"'].join("\n");

  return (
    <div className={`${PAGE} max-w-5xl *:max-w-3xl`}>
      <PageTitle>Developers</PageTitle>
      <nav aria-label="Developer sections" className="-my-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {[
          ["#keys", "API keys"],
          ["#webhook", "Webhook"],
          ["#usage", "Usage"],
          ["#mcp", "MCP"],
          ["#docs", "Docs"],
        ].map(([href, label]) => (
          <a key={href} href={href} className={`${LINK} inline-flex min-h-11 items-center`}>
            {label}
          </a>
        ))}
      </nav>
      {error ? <Notice tone="error">{ERRORS[error] ?? "Something went wrong. Try again."}</Notice> : null}
      {done === "revoked" ? <Notice tone="success">Key revoked. Requests with it now get 401 key_revoked.</Notice> : null}

      <Section
        id="keys"
        title="API keys"
        intro="A key lets your agent act for this company through the REST API and MCP. We store only a hash of it."
      >
        {!isOwner ? (
          <p className={HINT}>Only the company owner can see, create and revoke API keys.</p>
        ) : (
          <>
            <CreateKeyForm companyId={company.id} />
            {keys.length === 0 ? (
              <EmptyState title="Create a key to let your agent search candidates and request intros." />
            ) : (
              <ul className="grid gap-2">
                {keys.map((k) => (
                  <li key={k.key_id} className="grid gap-2 border-b border-line pb-3 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="grid min-w-0 gap-0.5">
                      <p className="font-semibold break-words text-ink">
                        {k.name}{" "}
                        <span className={k.revoked_at ? "text-sm font-normal text-ink-muted" : "text-sm font-normal text-ink"}>
                          {k.revoked_at ? "Revoked" : "Active"}
                        </span>
                      </p>
                      <p className="font-mono text-xs break-all text-ink-muted">{k.prefix}...</p>
                      <p className="text-xs text-ink-muted">
                        Created {at(k.created_at)}
                        {k.created_by_user_id ? ` by ${creators.get(k.created_by_user_id) ?? "a former member"}` : ""}.{" "}
                        {k.revoked_at ? `Revoked ${at(k.revoked_at)}.` : k.last_used_at ? `Last used ${at(k.last_used_at)}.` : "Never used."}
                      </p>
                    </div>
                    {k.revoked_at ? null : (
                      <form action={revokeKeyAction}>
                        <input type="hidden" name="company_id" value={company.id} />
                        <input type="hidden" name="key_id" value={k.key_id} />
                        <Button type="submit" variant="destructive" className="h-11 px-4">
                          Revoke
                        </Button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section
        id="webhook"
        title="Webhook"
        intro={
          <>
            We POST signed events when an intro is accepted, declined or expires: {WEBHOOK_EVENTS.join(", ")}. Failed deliveries are retried after
            1 min, 5 min, 30 min, 2 h and 12 h. Your agent can also poll list_intros with updated_since.
          </>
        }
      >
        {!configured ? <Notice tone="info">Webhooks are not available yet. Until then your agent can poll list_intros with updated_since.</Notice> : null}
        {hook.failing_since ? (
          <Notice tone="warning">
            <p className="font-semibold">Your webhook is failing</p>
            <p className="mt-1">
              Since {TIME.format(new Date(hook.failing_since))} UTC your endpoint did not accept events after 6 tries. Fix it and send a test.
            </p>
          </Notice>
        ) : null}
        {canWriteHook ? (
          <WebhookForm companyId={company.id} url={hook.url} enabled={hook.enabled} canWrite={!readOnlyApi} configured={configured} />
        ) : (
          <dl className="grid gap-1 text-sm">
            <dt className="text-ink-muted">Endpoint URL</dt>
            <dd className="break-all text-ink">{hook.url ?? "Not set"}</dd>
            <dt className="mt-2 text-ink-muted">Status</dt>
            <dd className="text-ink">{hook.url ? (hook.enabled ? "On" : "Off") : "Off"}. Only the owner can change the webhook.</dd>
          </dl>
        )}
        {canWriteHook && readOnlyApi ? (
          <p className={HINT}>Read-only: no active subscription. Your agent can still set the webhook through the API.</p>
        ) : null}

        <div className="grid gap-2">
          <h3 className="display text-[1.375rem] leading-none">Recent deliveries</h3>
          {queue.pending || queue.failed ? (
            <p className={HINT}>
              {queue.pending} waiting for a retry, {queue.failed} not delivered after 6 tries.
            </p>
          ) : null}
          {deliveries.length === 0 ? (
            <p className={HINT}>No deliveries yet. Send a test to check your endpoint.</p>
          ) : (
            <ol className="grid gap-2">
              {deliveries.map((d, i) => (
                <li key={i} className="grid gap-0.5 border-b border-line pb-2 text-sm last:border-b-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
                  <time dateTime={fromSqlTime(d.at).toISOString()} className="font-mono text-xs text-ink-muted">
                    {at(d.at)}
                  </time>
                  <span className="min-w-0 break-words text-ink">
                    <span className="font-semibold">{d.kind === "test" ? "Test ping" : d.event}</span>
                    {d.attempt && d.kind === "delivery" ? `, try ${d.attempt} of 6` : ""}:{" "}
                    {d.outcome === "delivered"
                      ? `delivered (HTTP ${d.statusCode})`
                      : `${d.outcome === "retrying" ? "failed, will retry" : "failed"} (${d.error ?? "no answer"})`}
                    {d.durationMs !== null ? `, ${d.durationMs} ms` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Section>

      <Section id="usage" title="Usage, last 30 days" intro="Successful calls by action and x402 spend. Pay per request is used only without a subscription.">
        {perAction.size === 0 ? (
          <p className={HINT}>No calls yet.</p>
        ) : (
          <div className="relative min-w-0 overflow-x-auto rounded-[10px] border-2 border-ink">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Action
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Calls
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    x402 spend
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...perAction.entries()]
                  .sort((a, b) => b[1].calls - a[1].calls)
                  .map(([action, r]) => (
                    <tr key={action} className={TR}>
                      <td className={`${TD} font-mono text-xs`}>{action}</td>
                      <td className={`${TD} text-right tabular-nums`}>{r.calls}</td>
                      <td className={`${TD} text-right tabular-nums`}>${(r.cents / 100).toFixed(2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="mcp" title="MCP and REST" intro="Give your agent the same actions as this app. Replace ncj_live_... with a key from above.">
        <p className="text-sm text-ink">MCP client settings (Claude Desktop, Cursor and others):</p>
        <Code>{mcpConfig}</Code>
        <p className="text-sm text-ink">REST, base URL {origin}/api/v1:</p>
        <Code>{curl}</Code>
      </Section>

      <Section id="docs" title="Docs">
        <ul className="grid gap-2 text-sm">
          <li>
            <a href="/openapi.yaml" className={LINK}>
              OpenAPI 3.1 contract
            </a>
            : all 28 REST operations, the x402 flow and the webhook events.
          </li>
          <li>
            <Link href="/how-scoring-works" className={LINK}>
              How scores work
            </Link>
            : what each source score means.
          </li>
          <li>
            <Link href="/terms/companies" className={LINK}>
              Company Terms
            </Link>
            : hiring only, no resale, no bulk export.
          </li>
        </ul>
        <div className="grid gap-2">
          <h3 className="display text-[1.375rem] leading-none">Verify a webhook</h3>
          <p className={HINT}>
            Each request has NCJ-Signature: t=unix seconds, v1=hex HMAC-SHA256 of t + &quot;.&quot; + raw body, keyed with the whole
            whsec_ secret. After a rotation we send two v1 values for 24 hours. Drop events older than 5 minutes and dedupe by NCJ-Event-Id.
          </p>
          <Code>{VERIFY_SNIPPET}</Code>
        </div>
      </Section>
    </div>
  );
}

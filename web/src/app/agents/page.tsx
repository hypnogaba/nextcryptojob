import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "REST and MCP for crypto jobs and candidates. Job search is free. Candidate search takes a company key or $0.50 in USDC per search with x402.",
};

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
const PRE = "overflow-x-auto rounded-[10px] border-2 border-ink bg-surface p-5 font-mono text-sm leading-relaxed";

// Справжні запити з договору API (docs/api/openapi.yaml, docs/api/mcp-tools.md).
const JOBS_LOG: readonly (readonly [string, string])[] = [
  ["GET", "/api/v1/public/jobs?role=engineer&work_mode=remote"],
  ["200", '{"data":[{"job_id":"nr_...","title":"Protocol Engineer","work_mode":["remote"]}],"next_cursor":null}'],
];

const CANDIDATES_LOG: readonly (readonly [string, string])[] = [
  ["POST", "/api/v1/candidates/search"],
  ["", '{"filters":{"role":"trader","min_level":8}}'],
  ["402", "Payment Required, x402: $0.50 USDC"],
  ["POST", "same body + PAYMENT-SIGNATURE"],
  ["200", '{"data":[{"label":"#B21E90","headline":{"role":"trader","score":81,"level":9}}]}'],
];

const MCP_CONFIG = `{ "mcpServers": { "nextcryptojob": {
    "url": "https://nextcryptojob.xyz/mcp",
    "headers": { "Authorization": "Bearer ncj_live_..." } } } }`;

function Log({ lines }: { lines: readonly (readonly [string, string])[] }) {
  return (
    <pre className={PRE}>
      {lines.map(([verb, rest]) => (
        <span key={rest} className="block">
          <span className="text-ink-muted">{verb.padEnd(5)}</span>
          {rest}
        </span>
      ))}
    </pre>
  );
}

function Block({ id, title, children, code }: { id: string; title: string; children: React.ReactNode; code: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid items-start gap-6 border-t-2 border-ink pt-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12">
      <div className="grid max-w-[52ch] gap-3">
        <h2 id={id} className="font-sans text-xl font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
      <div className="min-w-0">{code}</div>
    </section>
  );
}

/** Для агентів: REST, MCP і x402. Раніше це був розділ головної «Agents scout too». */
export default function AgentsPage() {
  return (
    <div className={`${WRAP} grid gap-14 pt-12 pb-24 sm:pt-16`}>
      <div className="grid max-w-[62ch] gap-5">
        <h1 className="display text-[clamp(3rem,1.5rem+5.4vw,6rem)] leading-[0.88]">Agents welcome.</h1>
        <p className="text-xl text-ink-muted">
          REST and MCP run the same actions as the site. Job search is free. Candidate search takes a company key, or an
          agent without one pays per search in USDC on Base or Solana with x402.
        </p>
        <p className="flex flex-wrap gap-x-6 gap-y-1">
          <a href="/openapi.yaml" className={`inline-flex min-h-11 items-center ${LINK}`}>
            OpenAPI spec (/openapi.yaml)
          </a>
          <Link href="/company/developers" className={`inline-flex min-h-11 items-center ${LINK}`}>
            API keys for companies
          </Link>
        </p>
      </div>

      <Block id="jobs-h" title="Search jobs, free" code={<Log lines={JOBS_LOG} />}>
        <p className="text-ink-muted">
          No key. Filter by role, remote or city, salary and free text. The same jobs people get in their daily list.
          The MCP tool is <code className="font-mono text-sm text-ink">search_jobs</code>. 30 requests a minute per IP.
        </p>
      </Block>

      <Block id="candidates-h" title="Search candidates" code={<Log lines={CANDIDATES_LOG} />}>
        <p className="text-ink-muted">
          With a company key and plan, searches are included in a daily quota. Without a plan or a key, the server
          answers 402 and your agent pays $0.50 in USDC per page of up to 20 results, then repeats the request with the
          payment.
        </p>
        <p className="text-ink-muted">
          Only visible candidates appear (anyone can hide), as anonymous labels with scores and reasons. Never names,
          handles, wallets or email. Intros and Telegram handles always need a key, so the candidate knows who asks.
        </p>
      </Block>

      <Block
        id="mcp-h"
        title="Connect over MCP"
        code={
          <pre className={PRE}>
            <code>{MCP_CONFIG}</code>
          </pre>
        }
      >
        <p className="text-ink-muted">
          Endpoint <code className="font-mono text-sm text-ink">https://nextcryptojob.xyz/mcp</code>, streamable HTTP.
          Without a key, the tool list has <code className="font-mono text-sm text-ink">search_jobs</code> (free) and{" "}
          <code className="font-mono text-sm text-ink">search_candidates</code> (x402). With a company key you get every
          tool: pipeline, intros, jobs, saved searches and webhooks.
        </p>
      </Block>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-6">
        <Button asChild size="lg">
          <Link href="/company">For companies</Link>
        </Button>
        <Link href="/" className={`inline-flex min-h-11 items-center ${LINK}`}>
          Looking for a job yourself?
        </Link>
      </div>
    </div>
  );
}

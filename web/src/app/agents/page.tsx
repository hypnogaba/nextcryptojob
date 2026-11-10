import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Crypto jobs in Claude, ChatGPT and MCP",
  description:
    "Connect your crypto job search to Claude or ChatGPT: matches, brief and live jobs as cards in the chat. Plus a free REST API and MCP server for agents.",
};

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
const PRE = "overflow-x-auto rounded-[10px] border-[1.5px] border-line bg-surface p-5 font-mono text-sm leading-relaxed";

// Справжні запити з договору API (docs/api/openapi.yaml, docs/api/mcp-tools.md).
const JOBS_LOG: readonly (readonly [string, string])[] = [
  ["GET", "/api/v1/public/jobs?role=engineer&work_mode=remote"],
  ["200", '{"data":[{"job_id":"nr_...","title":"Protocol Engineer","work_mode":["remote"]}],"next_cursor":null}'],
];

const CANDIDATES_LOG: readonly (readonly [string, string])[] = [
  ["POST", "/api/v1/candidates/search"],
  ["", "Authorization: Bearer ncj_live_..."],
  ["", '{"filters":{"role":"trader","min_level":8}}'],
  ["200", '{"data":[{"label":"#B21E90","headline":{"role":"trader","score":81,"level":9}}]}'],
];

// Конектор людини (lib/api/mcp-me.ts): адреса, яку вставляють у Claude чи ChatGPT, і що в нього питати.
const CONNECTOR_URL = "https://nextcryptojob.xyz/mcp/me";
const CONNECTOR_ASKS: readonly string[] = [
  "What did NextCryptoJob send me this week? Which one fits best?",
  "Find remote Solidity jobs paying over $150k.",
  "Write a short note to the hiring team for the second job, in my words.",
  "I moved to Lisbon. Change my brief to Lisbon or remote.",
  "Thumbs down the first one, the pay is too low.",
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
    <section aria-labelledby={id} className="grid items-start gap-6 border-t border-line pt-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12">
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

/** Для агентів: REST і MCP (x402 позначено «coming soon», поки вимкнений). Раніше це був розділ головної «Agents scout too». */
export default function AgentsPage() {
  return (
    <div className={`${WRAP} grid gap-14 pt-12 pb-24 sm:pt-16`}>
      <div className="grid max-w-[62ch] gap-5">
        <h1 className="display text-[clamp(3rem,1.5rem+5.4vw,6rem)] leading-[0.88]">Agents welcome.</h1>
        <p className="text-xl text-ink-muted">
          REST and MCP run the same actions as the site. Job search is free. Candidate search takes a company key with a
          subscription. Pay per request with x402 (USDC on Solana) is coming soon.
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

      <Block
        id="connector-h"
        title="Your job search inside Claude or ChatGPT"
        code={
          <div className="grid gap-4">
            <pre className={PRE}>
              <code>{CONNECTOR_URL}</code>
            </pre>
            <ul className="grid gap-2 text-ink-muted">
              {CONNECTOR_ASKS.map((q) => (
                <li key={q} className="rounded-[10px] border border-line px-4 py-3">
                  “{q}”
                </li>
              ))}
            </ul>
          </div>
        }
      >
        <p className="text-ink-muted">
          Looking for a job? Connect NextCryptoJob to your own AI app. It sees your brief and your daily matches, searches
          live jobs, and shows them as cards in the chat. Your AI writes notes and letters on your own plan, in your words.
        </p>
        <ol className="grid list-decimal gap-1 pl-5 text-ink-muted">
          <li>
            In Claude: <span className="text-ink">Settings → Connectors → Add custom connector</span>. In ChatGPT, add it as a
            custom connector in developer mode.
          </li>
          <li>Paste the address. Sign in with the email or Telegram you use here, then choose Allow.</li>
          <li>Ask in your own words. You can disconnect it at any time in the app.</li>
        </ol>
        <p className="text-ink-muted">
          It cannot see your wallets, X or GitHub details, message companies or delete your account. No account yet?{" "}
          <Link href="/start" className={LINK}>
            Start your brief
          </Link>
          .
        </p>
      </Block>

      <Block id="jobs-h" title="Search jobs, free" code={<Log lines={JOBS_LOG} />}>
        <p className="text-ink-muted">
          No key. Filter by role, remote or city, salary and free text. The same jobs people get in their daily list.
          The MCP tool is <code className="font-mono text-sm text-ink">search_jobs</code>. 30 requests a minute per IP.
        </p>
      </Block>

      <Block id="candidates-h" title="Search candidates" code={<Log lines={CANDIDATES_LOG} />}>
        <p className="text-ink-muted">
          Needs a company key and a subscription. Searches are included in a daily quota. Pay per request
          with x402 (about $0.50 in USDC per page) is coming soon, and is not available yet: without a key or a plan the
          API answers with an error.
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
          Without a key you can use <code className="font-mono text-sm text-ink">search_jobs</code>{" "}
          (free). With a company key and a subscription you get every tool: candidate search, pipeline, intros, jobs,
          saved searches and webhooks.
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

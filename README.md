# NextCryptoJob

**Crypto hiring based on proof of work.** NextCryptoJob reads what a person has actually done on
X, GitHub and their wallets, turns it into a 0 to 100 score for the role they want, and sends them
fresh crypto jobs every day. Companies search scored candidates in a small CRM and reach them only
after the candidate says yes. AI agents get the same features through REST and MCP, and can pay per
request with x402.

Live: https://nextcryptojob.xyz. Questions: `/faq`, or write to hello@nextcryptojob.xyz through `/contact`.
Got a job through NextCryptoJob? Tell us at `/feedback`.

## How it works

**Candidates (always free)**
1. Sign in with email (6-digit code) or Telegram. No wallet login.
2. Describe the job you want in your own words; we read your roles from it and you confirm them. A role
   that is not in our list can be written in your own words, and we match job titles by those words.
3. Type your X handle (required), paste up to 10 EVM and Solana wallets, and optionally add GitHub,
   YouTube and a site. We trust what you type: no codes in your bio; the public card says the sources
   are self-reported, and anyone can report a card.
4. Right away get a score per role with a full breakdown, one card to download and share on X, and a
   daily job digest by email or Telegram. Cards that stay public also appear on the leaderboard. The
   profile is private; companies see you only if you turn "Show me to companies" on.
5. Jobs sent to you stay on `/jobs` for 30 days (Today, Earlier, Saved), each with its own page that
   says why it matched.

**Companies (100 USDC per 30 days, paid on Solana)**
- Search candidates by role, score and level; a pipeline with notes and tags; job posts.
- Intros go through us: the candidate sees the request and decides. Contact is shared only after yes,
  or directly if the candidate chose "Telegram handle directly".

**AI agents**
- REST API (`docs/api/openapi.yaml`) and an MCP server (`docs/api/mcp-tools.md`).
- Pay with an API key, or per request in USDC with x402 on Solana ($0.50 per search, $5 per intro). The
  x402 route is built but switched off until we run our own Solana facilitator.
- Job search is open to any agent.

## The score

Ten roles: engineer, security auditor, devrel, data and research, product manager, BD, marketing and
content, creator/KOL, community, trader. Each role has a core of weighted sources, small bonuses, and
an anchor source it cannot be scored without. Sources:

| Source | What we read |
|---|---|
| X | followers, known crypto accounts that follow you, reactions on your own posts |
| GitHub | merged PRs to other people's repos, stars, recent activity; Spellbook PRs for data roles |
| Wallets | EVM (Ethereum, Arbitrum, Base, Optimism), Solana, Hyperliquid: age, chains, trades, volume |
| YouTube, site | audience, views, articles |
| Sherlock | audit contest earnings, only through a verified GitHub or X (no longer asked during setup) |

Missing data is shown as a gap with a reason, never hidden. The formula (v5) is written by hand and
documented in `docs/contracts.md` §4. It was checked against a reference set of 49 known crypto people
with an expected band (four bands, from newcomer to founder): 42 of 49 land in the expected band or the
next one, 21 of 49 in the exact band. The same set was used to shape the formula, so treat this as a
sanity check, not an accuracy claim.

## Architecture

| Part | Stack | Where |
|---|---|---|
| `web/` | Next.js 16 App Router, React 19, Tailwind v4, shadcn/ui | Cloudflare Workers via OpenNext |
| `engine/` | Node 24, TypeScript: collectors, formula, score queue, daily digest | VPS, systemd service and timers |
| `db/migrations/` | SQL for Cloudflare D1 | one D1 database |
| `docs/` | contract, specs, REST and MCP reference, legal texts | |
| `research/harness/` | Python harness used to design and test the formula | data about people stays out of git |

Payments: Solana Pay in USDC, one payment for 30 days of company access. A wallet scans a QR or opens a
`solana:` link with a unique reference; the Worker reads the chain over JSON-RPC and grants access when
the transfer lands. We hold no keys and no card data: only the public receiving address lives in the
Worker config. Sign-in: email codes through Cloudflare Email Service, and Telegram OpenID Connect.

## Job data

NextCryptoJob runs its own crypto-only job scanner (`engine/src/jobs`) with its own jobs database
(`db/jobs`, Cloudflare D1 `nextcryptojob-jobs`). Every day it reads the public job-board APIs of about
320 crypto employers (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Teamtailor and
others), the crypto boards web3.career (through its official Web3 Jobs API) and Remote3, and the crypto companies of the a16z
speedrun network. It keeps jobs posted in the last 30 days, turns every salary into a yearly range and
drops duplicates. The site and the daily digest only read that database. Sources and their terms:
`engine/deploy/README.md` §8.

Until 14 September 2026 the job listings came from NextRole, an earlier project by the same author. The
employer registry was seeded once from its public data, and some modules (the scanner parts, the D1 and
HTTP clients) were carried over from it and are marked in their headers. Nothing depends on NextRole at
runtime.

## Docs

- Contract (roles, formula, data shapes): `docs/contracts.md`
- Release spec: `docs/specs/2026-09-12-release1-design.md`
- CRM, agents and x402 spec: `docs/specs/2026-09-12-crm-agents-design.md`
- Decisions log: `docs/DECISIONS.md`
- REST reference: `docs/api/openapi.yaml`, MCP tools: `docs/api/mcp-tools.md`
- Legal texts published on the site: `docs/legal/`
- Backlog: `docs/BACKLOG.md`, operations: `docs/ops.md`

## Running it

```sh
cd web && npm ci && npm run dev          # site on http://localhost:3000
cd web && npm test && npm run typecheck && npm run build
cd engine && npm ci && npm test          # collectors, formula, digest, job scanner
cd engine && npm run parity              # formula in web must match the formula in engine
```

The site needs Cloudflare bindings (D1, the jobs D1, rate limiters) and a handful of secrets listed in
`docs/contracts.md` §8. Without them it still builds and runs the tests: every external call sits behind
a client that the tests replace. Deploy notes: `engine/deploy/README.md` for the VPS side, `wrangler
deploy` through OpenNext for the Worker.

## A note for readers

Code comments and commit messages are in Ukrainian; identifiers, UI text and documents are in English.
The formula lives in two copies, one in `web/` and one in `engine/`, and `npm run parity` fails the build
if they drift apart.

## Reporting a security issue

Write to hello@nextcryptojob.xyz with "security" in the subject. Please do not open a public issue for
anything that exposes candidate data. There is no bounty, but we answer and credit you if you want that.

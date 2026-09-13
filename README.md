# NextCryptoJob

**Crypto hiring based on proof of work.** NextCryptoJob reads what a person has actually done on
X, GitHub and their wallets, turns it into a 0 to 100 score for the role they want, and sends them
fresh crypto jobs every day. Companies search scored candidates in a small CRM and reach them only
after the candidate says yes. AI agents get the same features through REST and MCP, and can pay per
request with x402.

Live: https://nextcryptojob.xyz

## How it works

**Candidates (always free)**
1. Sign in with email (6-digit code) or Telegram. No wallet login.
2. Describe the job you want in your own words; we suggest matching roles.
3. Verify X with a code in your bio or a post, paste EVM and Solana wallets, and optionally add GitHub,
   YouTube, a site or a Sherlock profile.
4. Get a score per role with a full breakdown, a card to share on X, and a daily job digest by email
   or Telegram. The profile is private; companies see you only if you turn "Show me to companies" on.

**Companies (about $100 per month)**
- Search candidates by role, score and level; a pipeline with notes and tags; job posts.
- Intros go through us: the candidate sees the request and decides. Contact is shared only after yes,
  or directly if the candidate chose "Telegram handle directly".

**AI agents**
- REST API (`docs/api/openapi.yaml`) and an MCP server (`docs/api/mcp-tools.md`).
- Pay with an API key, or per request in USDC via x402 on Base or Solana ($0.50 per search, $5 per intro).
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
| Sherlock | audit contest earnings, only through a verified GitHub or X |

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
| `docs/` | contract, specs, plans, API | |
| `research/harness/` | Python harness used to design and test the formula | data about people stays out of git |

Payments: Stripe for subscriptions, x402 (Coinbase facilitator) for agents. Sign-in: email codes via
Cloudflare Email Service and Telegram OpenID Connect.

## Job data

The job listings come from NextRole, an earlier project by the same author. NextCryptoJob reads its
jobs database read-only; the scanner itself is not part of this repository. A few small modules (D1 and
HTTP clients) were carried over from NextRole and are marked in their headers.

## Docs

- Contract (roles, formula, data shapes): `docs/contracts.md`
- Release spec: `docs/specs/2026-09-12-release1-design.md`
- CRM, agents and x402 spec: `docs/specs/2026-09-12-crm-agents-design.md`
- Decisions log: `docs/DECISIONS.md`

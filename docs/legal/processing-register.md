# NextCryptoJob Record of Processing Activities (art. 30 GDPR)

> **DRAFT. For review by a French lawyer before launch.**
> This text is not legal advice. Points marked "[to confirm with lawyer]" are open.
> Version: 0.1 (draft), 2026-09-12. Internal document. Show to the CNIL on request.

Legal reference: art. 30 GDPR (<https://gdpr-info.eu/art-30-gdpr/>). The exemption for
organisations with fewer than 250 staff (art. 30(5)) does not apply here: the
processing is not occasional and includes profiling.

## 0. Controller

| Field | Value |
|---|---|
| Controller | [LEGAL NAME], sole trader (entrepreneur individuel) |
| SIRET | [SIRET] |
| Address | [ADDRESS] |
| Contact | [CONTACT EMAIL] |
| Representative in the EU | Not needed (established in France) |
| Data protection officer | None appointed [to confirm with lawyer: art. 37(1)(b) GDPR] |
| DPIA | Planned before launch. The CNIL list of processing that needs a DPIA includes "profiles of natural persons for human resources" (example: an algorithm that helps recruitment) and "profiling with data from external sources" (<https://www.cnil.fr/sites/default/files/atoms/files/liste-traitements-avec-aipd-requise-v2.pdf>). [to confirm with lawyer] |

## 1. Processing activities

### T1. Candidate accounts and sign-in

| Field | Value |
|---|---|
| Purpose | Create and run candidate accounts; sign-in by email code or Telegram; settings |
| Data subjects | Candidates |
| Data | Email; Telegram user ID and username; hashed sign-in codes; sessions; settings; target job text; roles; remote or city; minimum salary (optional) |
| Legal basis | Contract, art. 6(1)(b) |
| Recipients | Operator; Cloudflare (hosting, D1, email); Telegram (sign-in, messages) |
| Transfers | USA (Cloudflare) under DPF [to confirm]; Telegram [to confirm country and safeguard] |
| Retention | Active account; deletion after 24 months of inactivity with prior warning; codes 10 minutes; sessions [to confirm] |

### T2. Identity links and X verification

| Field | Value |
|---|---|
| Purpose | Link X, wallets, GitHub, YouTube, website to the account; verify X by code in bio or post; optional wallet signature; one address per account |
| Data subjects | Candidates |
| Data | X handle; EVM and Solana addresses; GitHub login; YouTube channel; website URL; verification method and date |
| Legal basis | Contract, art. 6(1)(b); legitimate interest in preventing impersonation, art. 6(1)(f) |
| Recipients | Operator; 6551 (reads X bio or post); Cloudflare |
| Transfers | 6551 [to confirm country and safeguard] |
| Retention | Active account |

### T3. Public data collection and scoring (profiling)

| Field | Value |
|---|---|
| Purpose | Collect public data from connected sources; compute a deterministic 0 to 100 score per chosen role, level and coverage; weekly refresh |
| Data subjects | Candidates who gave the `scoring` consent |
| Data | Counts and dates per source (see privacy policy 3.2); gap reasons; scores; breakdowns; formula version |
| Legal basis | Consent, art. 6(1)(a), and explicit consent, art. 22(2)(c) |
| Recipients | Operator; Contabo (engine server, Germany); 6551; GitHub; Etherscan; Blockscout; Helius; Hyperliquid; Google (YouTube Data API); Cloudflare (D1) |
| Transfers | Several sources outside the EU; see section 3 |
| Retention | Source counts replaced at each weekly refresh; all deleted on consent withdrawal or account deletion |
| Notes | No special category data. No inference of protected traits. Missing data is left out, never set to zero. Formula is human-written, public, versioned. |

### T4. Explanation text

| Field | Value |
|---|---|
| Purpose | Write a plain-language explanation of each score |
| Data subjects | Scored candidates |
| Data | Score breakdown and counts. No email, Telegram ID or wallet address [to confirm in implementation] |
| Legal basis | Consent (part of `scoring`) |
| Recipients | Anthropic |
| Transfers | USA under DPF or SCCs [to confirm] |
| Retention | Text stored with the score; deleted with it |

### T5. Score appeals (human review)

| Field | Value |
|---|---|
| Purpose | Let candidates contest a score and obtain human review |
| Data subjects | Candidates |
| Data | Appeal text; score data; decision and reason |
| Legal basis | Contract, art. 6(1)(b); art. 22(3) safeguard |
| Recipients | Operator |
| Transfers | None beyond hosting |
| Retention | Active account |

### T6. Card

| Field | Value |
|---|---|
| Purpose | Generate a shareable card and public card page |
| Data subjects | Candidates |
| Data | Score, role, level, pattern derived from handle |
| Legal basis | Consent, art. 6(1)(a) [to confirm product behaviour] |
| Recipients | The public (if published); Cloudflare |
| Transfers | Hosting only |
| Retention | Until unpublished or account deleted |

### T7. Visibility to companies and introductions

| Field | Value |
|---|---|
| Purpose | Show visible candidates to paying companies; handle introduction requests; share contact after approval or in direct mode |
| Data subjects | Candidates; company users |
| Data | Profile data (score, roles, level, networks, badges, place); introduction requests and answers; contact shared |
| Legal basis | Consent, art. 6(1)(a) (`visibility`, `contact.request`, `contact.direct`) |
| Recipients | Paying companies and approved agencies (profile data; contact only after approval or direct mode) |
| Transfers | Companies may be outside the EU [to confirm with lawyer: safeguard for disclosure to non-EU companies, for example art. 49(1)(a) explicit consent or SCCs in company terms] |
| Retention | Profile shown only while visibility is on; introduction records for the life of the candidate account [to confirm] |

### T8. Job digest

| Field | Value |
|---|---|
| Purpose | Send a daily list of matching jobs by email or Telegram |
| Data subjects | Candidates |
| Data | Email or Telegram ID; roles; place; salary; sent history |
| Legal basis | Consent, art. 6(1)(a) (`digest.email`, `digest.telegram`) [to confirm with lawyer] |
| Recipients | Cloudflare (email); Telegram |
| Transfers | See T1 |
| Retention | Sent history 12 months [to confirm] |

### T9. Company accounts, CRM, billing

| Field | Value |
|---|---|
| Purpose | Company accounts and teams; CRM (search, saved searches, pipeline, notes); job posts; subscriptions; invoices |
| Data subjects | Company users; candidates (in notes and pipeline) |
| Data | Name, work email, company, team role; billing data; subscription status; invoices; saved searches; pipeline stages; notes; tags |
| Legal basis | Contract, art. 6(1)(b); accounting duty, art. 6(1)(c) and art. L123-22 French Commercial Code (<https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006219327>). For notes and pipeline: processor for the company under art. 28 [to confirm with lawyer] |
| Recipients | Operator; Stripe; Cloudflare |
| Transfers | Stripe [to confirm entity and safeguard]; Cloudflare DPF [to confirm] |
| Retention | Account data for the contract plus 30 days; invoices 10 years |

### T10. API, MCP and x402

| Field | Value |
|---|---|
| Purpose | Give company agents programmatic access; take per-request payments |
| Data subjects | Company users; candidates (data returned) |
| Data | Hashed API keys; request logs; x402 payer wallet address; transaction hash; amount |
| Legal basis | Contract, art. 6(1)(b); accounting duty, art. 6(1)(c) |
| Recipients | x402 facilitator (Coinbase CDP, backup PayAI) [to confirm role and safeguard]; public blockchains |
| Transfers | Facilitator [to confirm] |
| Retention | Request logs 12 months [to confirm]; payment records 10 years |

### T11. Agency applications

| Field | Value |
|---|---|
| Purpose | Review and approve recruiting agencies |
| Data subjects | Agency staff |
| Data | Name, work email, agency details, answers to the form |
| Legal basis | Steps before a contract, art. 6(1)(b) |
| Recipients | Operator |
| Transfers | Hosting only |
| Retention | Approved: as T9. Refused: 12 months [to confirm] |

### T12. Security, abuse prevention and audit

| Field | Value |
|---|---|
| Purpose | Rate limits, sign-in protection, fraud and abuse detection, audit log |
| Data subjects | All users |
| Data | IP address; timestamps; sign-in attempts; action log |
| Legal basis | Legitimate interest, art. 6(1)(f); security duty, art. 32 |
| Recipients | Operator; Cloudflare |
| Transfers | Cloudflare DPF [to confirm] |
| Retention | 6 months to 1 year, per CNIL logging recommendation (<https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation>) [to confirm exact period] |

### T13. Audience measurement

| Field | Value |
|---|---|
| Purpose | Aggregated page statistics |
| Data subjects | Site visitors |
| Data | Page views, referrer, country, device type; no cookies |
| Legal basis | Legitimate interest, art. 6(1)(f) |
| Recipients | Cloudflare (Web Analytics) |
| Transfers | DPF [to confirm] |
| Retention | Per Cloudflare Web Analytics defaults [to confirm] |

### T14. Formula calibration (reference set)

| Field | Value |
|---|---|
| Purpose | Test the formula against a hand-labelled reference set before applying it to users (quality gate) |
| Data subjects | About 50 publicly known crypto professionals who are not users, plus the operator |
| Data | Public handles and addresses; counts from the same sources as T3; hand-made level labels |
| Legal basis | Legitimate interest, art. 6(1)(f) [to confirm with lawyer] |
| Information | Public notice in privacy policy section 12, art. 14(5)(b) [to confirm with lawyer] |
| Recipients | Operator only; stored outside the code repository (operator's computer and engine server) |
| Transfers | Same sources as T3 at collection time |
| Retention | Until the set is replaced; review each year [to confirm] |

### T15. Job listings

| Field | Value |
|---|---|
| Purpose | Collect public job listings for digests |
| Data subjects | Recruiters named in job posts (if any) |
| Data | Job text as published, which may include a contact name |
| Legal basis | Legitimate interest, art. 6(1)(f) |
| Recipients | Candidates (in digests) |
| Retention | Until the listing expires plus [to confirm] |

### T16. Rights requests

| Field | Value |
|---|---|
| Purpose | Handle access, deletion, export and other rights requests |
| Data subjects | Candidates, company users, reference-set people |
| Data | Request, identity check, answer |
| Legal basis | Legal obligation, art. 6(1)(c) |
| Recipients | Operator |
| Retention | 5 years after the answer [to confirm with lawyer] |

## 2. Security measures (art. 32 GDPR)

- HTTPS everywhere; HSTS.
- Sign-in codes and API keys stored as hashes; codes live 10 minutes with 5 attempts.
- Rate limits per email, per IP and per API key.
- Telegram webhook protected by a secret header.
- Companies isolated from each other at query level; tests check cross-company access.
- Companies never receive wallet addresses or raw source data.
- Secrets kept in Worker secrets and in a root-only environment file on the engine server; never in the repository.
- Admin access limited to the operator, with strong authentication.
- Audit log for consent changes, exports, deletions, contact sharing and admin actions.
- Database point-in-time recovery up to 30 days (<https://developers.cloudflare.com/d1/reference/time-travel/>).
- Security review before launch (implementation plan step 4.2).
- Breach procedure: assess, notify the CNIL within 72 hours where required (art. 33), inform people where the risk is high (art. 34).

## 3. Processors and data sources

| Name | Role | Country | Safeguard | DPA signed |
|---|---|---|---|---|
| Cloudflare, Inc. | Processor: hosting, D1, email, analytics | USA, global | DPF [to confirm] | [to confirm] |
| Contabo GmbH | Processor: engine server | Germany | EU | [to confirm] |
| Stripe | Processor and independent controller for payment fraud and compliance [to confirm] | Ireland, USA | DPF or SCCs [to confirm] | [to confirm] |
| 6551 | Processor: X data | [to confirm] | SCCs [to confirm] | [to confirm] |
| Etherscan | Data source [to confirm role] | [to confirm] | [to confirm] | [to confirm] |
| Blockscout | Data source [to confirm role] | [to confirm] | [to confirm] | [to confirm] |
| Helius | Processor: Solana RPC | USA [to confirm] | DPF or SCCs [to confirm] | [to confirm] |
| Hyperliquid | Public data source | [to confirm] | [to confirm] | Not applicable [to confirm] |
| GitHub, Inc. | Data source | USA | DPF [to confirm] | [to confirm] |
| Google LLC | Data source (YouTube Data API) | USA | DPF [to confirm] | [to confirm] |
| Telegram | Messaging and sign-in; likely independent controller [to confirm] | [to confirm] | [to confirm] | [to confirm] |
| Anthropic | Processor: explanation text | USA [to confirm entity] | DPF or SCCs [to confirm] | [to confirm] |
| Coinbase (CDP x402 facilitator), PayAI | Payment facilitation [to confirm role] | [to confirm] | [to confirm] | [to confirm] |
| Amazon SES (backup email, if used) | Processor | EU or USA [to confirm] | DPF or SCCs [to confirm] | [to confirm] |

For each transfer based on SCCs, write a transfer impact assessment
(CNIL guide: <https://www.cnil.fr/fr/analyse-dimpact-des-transferts-des-donnees-la-cnil-publie-la-version-finale-de-son-guide-aitd>).

## 4. Change log

| Date | Change |
|---|---|
| 2026-09-12 | First draft |

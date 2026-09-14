# NextCryptoJob Privacy Policy

> **DRAFT. Not in force. For review by a French lawyer before launch.**
> This text is not legal advice. Points marked "[to confirm with lawyer]" are open.
> Version: 0.2 (draft), 2026-09-14.

This policy explains what personal data NextCryptoJob processes, why, on what legal
basis, who receives it, how long we keep it, and what rights you have. It covers the
information required by articles 13 and 14 of the GDPR
(<https://gdpr-info.eu/art-13-gdpr/>, <https://gdpr-info.eu/art-14-gdpr/>).

## 1. Summary

- Candidates never pay. Companies pay.
- There are no boxes to tick. At the end of setup we write "By continuing you agree to the Terms and Privacy." Pressing Continue, and using the service, means you accept the Terms for Candidates and this policy. We record the version and the date.
- This is not a one-time step: continuing to use NextCryptoJob at any point, including changing a toggle in Settings, means you still accept the current Terms for Candidates and this policy.
- When you finish setting up, "Show me to companies" and "Show my Telegram directly" are on. Companies with access can then find you and see your score and Telegram handle. You can turn either off at any time in Settings.
- Computing a score from public data about the accounts and wallets you add is part of the service. If you add none, there is nothing to score.
- The formula is written by people and is the same for everyone. A language model writes explanation text only. It does not set your score.
- While "Show my Telegram directly" is on, companies also see your Telegram, X, GitHub, YouTube, website and wallet addresses at once, not only your score. Companies never see your email without your approval, or raw data such as your posts or transaction history.
- You can appeal your score, export your data and delete your account at any time.
- We use one session cookie. We use no advertising trackers.

## 2. Who is responsible for your data

The controller is:

- [LEGAL NAME], sole trader (entrepreneur individuel), France
- SIRET: [SIRET]
- Address: [ADDRESS]
- Contact for all privacy questions: [CONTACT EMAIL]

We have not appointed a data protection officer. [to confirm with lawyer: whether article 37(1)(b) GDPR applies, <https://gdpr-info.eu/art-37-gdpr/>]

## 3. What data we process

### 3.1 Data you give us

| Data | When |
|---|---|
| Email address | If you sign in by email |
| Telegram user ID and username | If you sign in with Telegram |
| What job you seek, in your own words | First sign-in |
| Roles you choose | First sign-in, settings |
| Remote or city | First sign-in, settings |
| Minimum salary | Optional |
| X handle | When you connect X |
| Wallet addresses (EVM and Solana) | When you paste them |
| GitHub login, YouTube channel, website address | Optional |
| Your settings and choices (channel, digest hour, visibility, contact mode, consents) | Settings |
| Messages you send us, such as a score appeal | When you write to us |

### 3.2 Data we collect from public sources

When you add accounts and wallets, we collect public data about them to compute your
score. This is the information that article 14 GDPR requires about data we
did not get from you directly.

| Source | What we collect | Through |
|---|---|---|
| X | Follower count; how many known accounts follow you; on your own recent posts: likes, reposts, views, replies; how often you post | 6551 (third-party X data provider) |
| GitHub | Pull requests merged into other people's repositories, stars, reviews, followers, commits, active repositories, repositories with a website | GitHub API |
| EVM wallets | Wallet age, number of sent transactions, networks used, swaps (by method name) | Etherscan (Ethereum, Arbitrum), Blockscout (Base, Optimism) |
| Hyperliquid | Number of recent trades, trading volume | Hyperliquid public API |
| Solana wallets | Transaction signatures, wallet age, swaps | Helius (Solana RPC) |
| YouTube | Subscribers, views of recent videos, how often you publish | YouTube Data API (Google) |
| Website | Number of posts and how recent they are | Your site's RSS feed and sitemap |

We store counts and dates, not the full content of your posts or transactions. The
data passes through our scoring engine to compute these counts.
[to confirm with lawyer and in code: no post text or transaction list is kept after the counts are computed]

### 3.3 Data we create

- Your score (0 to 100) for each role you choose, your level (1 to 10), and your coverage (how many sources count).
- A breakdown of each score and a plain-language explanation.
- Verification badges (for example "X verified", "wallet verified by signature").
- Your card (score, role, level, and a pattern made from your handle).
- A record of your consents, with version and date.
- Introduction requests from companies and your answers.

### 3.4 Technical data

- A session cookie that keeps you signed in.
- Sign-in codes (stored as a hash, valid 10 minutes, 5 attempts).
- Security records: IP address, time, and result of sign-in attempts; rate-limit counters.
- A log of important actions in your account (for example consent changes, exports, deletion).

### 3.5 Data we do not collect

We do not ask for, and do not store, your age, gender, nationality, origin, photo,
health, religion, political opinion or any other special category of data under
article 9 GDPR (<https://gdpr-info.eu/art-9-gdpr/>). Companies cannot filter
candidates by such characteristics. We do not try to infer them from your data.

### 3.6 Company users

For people who use NextCryptoJob on behalf of a company, we process: name, work email,
company name, role in the team, billing details, subscription status, invoices, API
keys (stored as a hash), usage records, saved searches, pipeline stages, notes and
tags, and, for x402 payments, the paying wallet address and the transaction hash.

## 4. Why we process your data and on what legal basis

| Purpose | Main data | Legal basis |
|---|---|---|
| Create and run your account, sign you in | Email or Telegram ID, settings | Contract, art. 6(1)(b) GDPR <https://gdpr-info.eu/art-6-gdpr/> |
| Collect public data and compute your score (profiling) | Sections 3.1 to 3.3 | Contract, art. 6(1)(b): the score is part of the service you accept at the end of setup. It uses only the sources you add. |
| Write the plain-language explanation of your score | Score breakdown and counts | Contract, art. 6(1)(b) (part of the score) |
| Publish your card page | Score, role, level, pattern | Your consent (you choose to publish) [to confirm product behaviour: card page public only after you publish it] |
| Show your profile to companies | Score, roles, level, networks, badges | Contract, art. 6(1)(b): being found by companies is what the service is for. On when you finish setting up; you can turn it off at any time in Settings. |
| Share your contact with a company | Your Telegram handle ("direct" mode, on when you finish setting up, off in Settings); your Telegram handle or email after you accept a request | Contract, art. 6(1)(b), in "direct" mode; your consent, art. 6(1)(a), for each request you accept. In "direct" mode we never share your email. |
| Send your daily job digest by email or Telegram | Email or Telegram ID, roles, place, salary | Your consent, art. 6(1)(a). The digest can include jobs posted by paying companies, so we also treat it as covered by art. L34-5 of the French Postal and Electronic Communications Code <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042155961/> [to confirm with lawyer: consent or contract basis for the digest] |
| Review your score by a person when you appeal | Your appeal, score data | Contract, and our duty to offer human review under art. 22(3) GDPR |
| Answer your rights requests | Identity check data, request | Legal obligation, art. 6(1)(c) GDPR |
| Keep the service secure, stop abuse and fraud (rate limits, reports about cards, logs) | Technical data, identifiers | Legitimate interest in protecting users and the service, art. 6(1)(f) GDPR |
| Measure site audience without cookies | Page views, aggregated | Legitimate interest, art. 6(1)(f) |
| Send service messages (security, changes to terms, inactivity warning) | Email or Telegram ID | Contract, art. 6(1)(b), and legal obligation where it applies |
| Manage company subscriptions, invoices and accounting | Company user and billing data | Contract, art. 6(1)(b); legal obligation to keep accounting records, art. L123-22 French Commercial Code <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006219327> |
| Test the scoring formula against a reference set (see section 12) | Public data of reference people | Legitimate interest, art. 6(1)(f) [to confirm with lawyer] |

You can use your account and receive the job digest without adding any source. Then
we have nothing to score.

You can turn "Show me to companies" and "Show my Telegram directly" off, stop the
digest, or withdraw any consent at any time in Settings. This does not affect
processing that happened before (art. 7(3) GDPR, <https://gdpr-info.eu/art-7-gdpr/>).
If you remove a source or delete your account, we stop collecting its public data and
delete the data we collected.

## 5. Profiling and automated decisions

This section gives the information required by articles 13(2)(f), 14(2)(g) and 15(1)(h)
GDPR (<https://gdpr-info.eu/art-15-gdpr/>).

**What happens.** Your score is profiling under article 4(4) GDPR
(<https://gdpr-info.eu/art-4-gdpr/>). A formula evaluates public signals about your
work in crypto.

**The logic.** People wrote the formula. It is deterministic: the same data always
gives the same score. The steps are:

1. We turn each source into facts (counts and dates).
2. We turn the facts into a source score from 0 to 100, on scales set so that the best people in the industry score 90 to 100.
3. Each role has main sources and optional extras. Your role score is the main part plus up to 10 bonus points, and never more than 100.
4. If a source did not answer or gave no value, we leave it out. We never count it as zero.
5. Your level is your score divided by 10, rounded down, plus 1, with a maximum of 10.

The full explanation is on our public page "How scoring works" (see `how-scoring-works.md`).
Each score in your account shows its breakdown.

**The language model.** A language model (Anthropic) writes the plain-language text
that explains your score. It does not calculate, change or rank your score.

**What it means for you.** While "Show me to companies" is on, companies can
search, sort and filter candidates by score. A low score can mean that fewer companies
find you. A score does not decide whether you get a job. Our terms forbid companies to
make hiring or rejection decisions based solely on automated processing, including the
score.

**Our position on article 22 GDPR.** We do not take hiring decisions. But the Court of
Justice of the EU held that a score can be an automated decision when a third party
"draws strongly" on it (SCHUFA, case C-634/21, 7 December 2023,
<https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62021CJ0634>). So we apply
the safeguards of article 22 anyway:

- We tell you at the end of setup that the score is part of the service, and you can remove your sources or delete your account at any time.
- You can ask a person to review your score.
- You can give your point of view and contest the score.
- You can see how your score was calculated.

**How to appeal.** Use the "Appeal this score" button next to any score, or write to
[CONTACT EMAIL]. A person reviews your data, the breakdown and your arguments. We
answer within one month (art. 12(3) GDPR, <https://gdpr-info.eu/art-12-gdpr/>). If we
find an error, we correct the score. If the formula is wrong for a whole group, we fix
the formula and publish a new version.

## 6. Who receives your data

- **Companies**, while "Show me to companies" is on. It is on for new candidates unless they untick it on the last setup step, and you can turn it off at any time. They see your score, roles, level, networks and verification badges. While "Show my Telegram directly" is also on (also on unless you untick it), they see your Telegram handle at once, and your X, GitHub, YouTube, website and wallet addresses too, so they can look at your public work themselves. If you turn "Show my Telegram directly" off, they see none of these until you approve a request: only your contact appears then, never your links or wallet addresses. We never show your email without your approval, and never your raw data such as your posts or transaction history.
- **The public**, only for your card page if you publish it. The card shows score, role and level. It shows no wallets and no links. [to confirm product behaviour: whether the card shows your X handle and whether search engines may index it]
- **Our service providers** (processors), listed in section 7. They act on our instructions.
- **Data sources.** To collect public data, we send your handle or address to the source (for example your wallet address to Etherscan). We do not send your name or email.
- **Authorities**, only when the law requires it.

We do not sell your data. We do not share it with advertising networks.

## 7. Service providers and data sources

| Provider | What they do | Location | Transfer safeguard |
|---|---|---|---|
| Cloudflare, Inc. | Hosting, D1 database, email sending, cookieless web analytics | USA, global network [to confirm: D1 data location] | EU-US Data Privacy Framework (DPF) [to confirm status] |
| Contabo GmbH | Server for the scoring engine | Germany | None needed (EU) |
| Stripe | Card payments for companies | Ireland and USA [to confirm contracting entity] | DPF or SCCs [to confirm] |
| 6551 | X (Twitter) public data | [to confirm country and legal entity] | SCCs [to confirm; data processing agreement not yet confirmed] |
| Etherscan | EVM wallet data (Ethereum, Arbitrum) | [to confirm] | [to confirm] |
| Blockscout | EVM wallet data (Base, Optimism) | [to confirm] | [to confirm] |
| Helius | Solana wallet data | USA [to confirm] | DPF or SCCs [to confirm] |
| Hyperliquid | Public trading data | [to confirm] | [to confirm] |
| GitHub, Inc. | Public GitHub data | USA | DPF [to confirm status] |
| Google LLC | YouTube Data API | USA | DPF [to confirm status] |
| Telegram | Sign-in, messages, digest | [to confirm: UAE or other] | [to confirm with lawyer] |
| Anthropic | Writes explanation text | USA [to confirm contracting entity] | DPF or SCCs [to confirm] |

Some data sources (for example Hyperliquid, Etherscan, GitHub, Google) are public
services that we query. They may act as independent controllers, not as our
processors. [to confirm with lawyer for each provider]

We send Anthropic only the counts and score breakdown needed to write the text. We do
not send your email, Telegram ID or wallet addresses. [to confirm in implementation]

## 8. Transfers outside the EU

Some providers are in the USA or other countries outside the European Economic Area.
We transfer data only with a safeguard required by chapter V GDPR
(<https://gdpr-info.eu/chapter-5/>):

- For US companies certified under the EU-US Data Privacy Framework: the Commission adequacy decision (EU) 2023/1795 (<https://eur-lex.europa.eu/eli/dec_impl/2023/1795/oj>), art. 45 GDPR. You can check certification on <https://www.dataprivacyframework.gov/list>. The EU General Court upheld this decision on 3 September 2025 (case T-553/23, Latombe, <https://curia.europa.eu/juris/liste.jsf?num=T-553/23>). An appeal is pending (case C-703/25 P, <https://curia.europa.eu/juris/liste.jsf?num=C-703/25>). If the decision falls, we will switch to standard contractual clauses.
- For other providers: the standard contractual clauses of the European Commission, decision (EU) 2021/914 (<https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj>), art. 46 GDPR, with a transfer impact assessment as the CNIL recommends (<https://www.cnil.fr/fr/analyse-dimpact-des-transferts-des-donnees-la-cnil-publie-la-version-finale-de-son-guide-aitd>).

**Companies outside the EU.** Some companies that pay for access may be outside the EU.
While "Show me to companies" is on, they can see your profile data. While "Show my Telegram
directly" is on, or after you approve their request, they receive your contact. [to confirm with lawyer: safeguard for these
disclosures, for example standard contractual clauses in the company terms, or explicit
consent under art. 49(1)(a) GDPR, <https://gdpr-info.eu/art-49-gdpr/>]

You can ask us for a copy of the safeguards at [CONTACT EMAIL].

## 9. How long we keep your data

| Data | How long |
|---|---|
| Account, profile, scores, source data | While your account is active. If you do not sign in or use the service for 24 months, we warn you, then delete the account. This follows the CNIL guidance of 2 years after the last contact for candidate data (<https://www.cnil.fr/fr/cnil-direct/question/recrutement-un-employeur-peut-il-conserver-mon-dossier>). |
| Source data (counts) | Replaced at each weekly refresh. Deleted when you remove the source or delete your account. |
| Sign-in codes | 10 minutes |
| Sessions | Until you sign out or the session expires [to confirm duration] |
| Security logs | 6 months to 1 year, as the CNIL recommends (<https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation>) [to confirm exact period] |
| Consent records | For the life of the account, then 5 years as proof [to confirm with lawyer] |
| Appeals | For the life of the account |
| Company invoices and accounting records | 10 years (art. L123-22 French Commercial Code) |
| Database backups | Up to 30 days (Cloudflare D1 point-in-time recovery, <https://developers.cloudflare.com/d1/reference/time-travel/>) |
| Data a company received after you approved contact | Controlled by that company. Our terms ask them to follow the CNIL 2-year rule. |

Blockchain transactions are public and permanent. We cannot delete them. We can only
delete our copy of the counts.

## 10. Your rights

You have the right to:

- access your data (art. 15 GDPR, <https://gdpr-info.eu/art-15-gdpr/>);
- correct it (art. 16, <https://gdpr-info.eu/art-16-gdpr/>);
- delete it (art. 17, <https://gdpr-info.eu/art-17-gdpr/>);
- restrict its use (art. 18, <https://gdpr-info.eu/art-18-gdpr/>);
- receive it in a portable format (art. 20, <https://gdpr-info.eu/art-20-gdpr/>);
- object to processing based on legitimate interest (art. 21, <https://gdpr-info.eu/art-21-gdpr/>);
- withdraw consent at any time (art. 7(3));
- get human review of your score, give your view and contest it (art. 22(3));
- give instructions about your data after your death (art. 85 French Data Protection Act, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000039280582>). You can also choose to have your data sent to a person you name.

**How.** Settings has "Download my data" and "Delete my account". For anything else,
write to [CONTACT EMAIL]. We answer within one month. We may ask you to confirm your
identity by signing in.

**Complaint.** You can complain to the CNIL, the French data protection authority
(art. 77 GDPR, <https://gdpr-info.eu/art-77-gdpr/>): <https://www.cnil.fr/fr/plaintes>,
3 Place de Fontenoy, TSA 80715, 75334 Paris Cedex 07. You can also complain to the
authority in the EU country where you live or work.

## 11. Cookies and similar technologies

- **Session cookie.** It keeps you signed in and protects sign-in. It is strictly necessary for the service you ask for, so it needs no consent under article 82 of the French Data Protection Act (<https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000037813978>) and the CNIL guidelines (<https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies/FAQ>).
- **Audience measurement.** We use Cloudflare Web Analytics, which does not place cookies or use local storage on your device. It gives us aggregated page statistics.
- **No advertising or tracking cookies.** We do not use advertising pixels, social media trackers or fingerprinting.

Because we use only strictly necessary storage, we do not show a cookie banner.
[to confirm with lawyer]

## 12. People who are not our users

**Reference set.** To test the formula, we keep a reference set of about 50 people who
are publicly known in crypto. We collected public data about them from the sources in
section 3.2 and labelled their level by hand. We use it only to check that the formula
is accurate before we apply it to users. We do not show these people's scores to
anyone, and we do not contact companies about them. If you think you are in this set,
you can object and ask for deletion at [CONTACT EMAIL]. We publish this notice here to
meet article 14(5)(b) GDPR. [to confirm with lawyer: legal basis and whether this notice is enough]

**Other people in your data.** Your transactions involve other wallets. Your followers
include other accounts. We do not store these other people's data. We store only counts
(for example "12 known accounts follow you").

## 13. Minimum age

You must be at least 18 to use NextCryptoJob. [to confirm with lawyer: 18 or 16; French
digital consent age is 15, art. 45 French Data Protection Act,
<https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000037823135>]

## 14. Security

- Data in transit is encrypted (HTTPS).
- Sign-in codes and API keys are stored as hashes.
- We limit sign-in attempts per email and per IP address.
- Access to the admin area and servers is limited to the operator, with strong authentication.
- Secrets are kept outside the code repository.
- Companies cannot see each other's data.
- We keep an audit log of sensitive actions.

If a breach puts your rights at high risk, we will tell you without undue delay
(art. 34 GDPR, <https://gdpr-info.eu/art-34-gdpr/>).

## 15. Changes

If we change this policy in a way that matters to you, we tell you by email or Telegram
before the change takes effect. If a change needs new consent, we ask for it again.

## 16. Contact

[LEGAL NAME], [ADDRESS], [CONTACT EMAIL].

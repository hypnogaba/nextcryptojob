# How Scoring Works

> **DRAFT. Not in force. For review by a French lawyer before launch.**
> Public page text. Points marked "[to confirm with lawyer]" are open.
> Version: 0.1 (draft), 2026-09-12. Formula version described: v4.

NextCryptoJob gives you a score from 0 to 100 for each role you choose. This page
explains where the score comes from and how to contest it.

## In short

- People wrote the formula. It is the same for everyone. The same data always gives the same score.
- We use only public data from accounts and wallets that you connect.
- If a source gives us nothing, we leave it out. Missing data is never counted as zero.
- A language model writes the text that explains your score. It does not calculate or change the score.
- You choose your roles. We only suggest.
- You can ask a person to review any score.
- We score you only if you agree. You can stop at any time.

## What we look at

| Source | What we measure |
|---|---|
| X | How many people follow you; how many well-known crypto accounts follow you; how people react to your own posts (likes, reposts, views, replies); how often you post |
| GitHub | Pull requests merged into other people's projects; stars on your projects; code reviews; followers; commits in the last 12 months; projects you worked on recently; projects with a live website |
| EVM wallets (Ethereum, Arbitrum, Base, Optimism) | How old the wallet is; how many transactions it sent; how many networks it uses; how many swaps it made |
| Hyperliquid | Recent trades and trading volume |
| Solana wallets | How old the wallet is; number of transactions; swaps |
| YouTube | Subscribers; views of recent videos; how often you publish |
| Your website | How many posts it has and how recent they are |

We read your own posts only to count reactions. We do not judge what you write. We keep
counts and dates, not the content.

We do not look at: your age, gender, nationality, photo, or anything like them. We do
not look at your profit or loss, or how much money is in your wallets. We do not score
people who have not signed up.

## Principles

**1. Each role has main sources.** An engineer is measured mainly on GitHub. A trader
is measured mainly on trading activity. Media roles are measured mainly on X or
YouTube. Some roles use two main sources.

**2. Extras can only add.** Other sources can add up to 10 bonus points. An extra source
that you did not connect takes nothing away.

**3. A role needs its main source.** Without it we cannot score the role fairly, so we
show "not enough data" instead of a low score. For example: an engineer without
GitHub, a trader without trades, or a creator without X or YouTube.

**4. Missing is not zero.** Sometimes a source does not answer, hides a number, or has
too little data to be reliable. Then we leave that part out of the calculation and show
the reason. We never turn a gap into a zero.

**5. X or YouTube, the stronger one counts.** For media roles, we use whichever channel
is stronger for you. You do not need both.

**6. Large numbers are compressed.** Going from 0 to 1,000 followers counts more than
going from 100,000 to 101,000. Each measure has a ceiling. Scales are set so that the
best people in the industry score 90 to 100.

**7. The score is capped.** Main part plus bonus, never more than 100.

**8. We test before we switch on.** Before a formula version is used for real people,
we test it against a reference set of people whose level was judged by hand. We do not
switch it on unless it is close enough to that judgment.

## Roles

These roles are scored now:

- Engineer
- Security auditor
- DevRel
- Data and research
- Product or project manager
- BD and partnerships
- Marketing and content
- Creator or KOL
- Community
- Trader

These roles are not scored yet, because public data does not show the work well:

- Designer (needs a portfolio)
- Operations and support, Finance, Legal and compliance, HR and recruiting (need a CV)

You can still choose them for your job digest. [to confirm product behaviour]

## Levels

Your level goes from 1 to 10. It is your score divided by 10, rounded down, plus 1.
The maximum is 10. For example, a score of 67 is level 7.

## Coverage

Next to each score we show coverage: how much of the role's main part is based on real
data. Low coverage means the score rests on fewer sources. Connecting more sources can
raise coverage.

## What your score page shows

- Your score for each role.
- Each source's part, with the reason for any gap.
- A plain-language explanation.
- Tips on what you could connect or do to show more of your work.
- The formula version.

## Known limits

- Selling tokens you received as a gift can count as a swap.
- Audit contest results are not yet included, so security auditors may score lower than they should.
- We do not resolve ENS or SNS names. Paste the address.
- A wallet you did not verify by signature carries no "verified" badge.

## Refresh

We refresh your data about once a week. Your score can change when your public activity
changes or when we release a new formula version.

## Who sees your score

- You.
- The public, only on your card page if you publish it: score, role and level. No wallets, no links.
- Paying companies, while "Show me to companies" is on. It is on when you finish setting up, and you can turn it off at any time in Settings. They can filter by score. While "Show my Telegram directly" is also on, they also see your Telegram, X, GitHub, YouTube, website and wallet addresses. They never see your email without your approval, or raw data.

Companies must not decide to hire or reject anyone based only on the score. A person
must decide.

## Appeal

If you think a score is wrong:

1. Press "Appeal this score" next to it, or write to [CONTACT EMAIL].
2. Tell us what is wrong. You can add links or context.
3. A person checks your data, the breakdown and your arguments.
4. We answer within one month. If we find an error, we correct the score. If the formula is wrong for a group of people, we fix the formula and publish a new version.

This is your right under article 22(3) of the GDPR (<https://gdpr-info.eu/art-22-gdpr/>).

## Why this is not an "AI system"

The formula is a set of rules written by people. It does not learn from data. Under
the EU AI Act, systems "based on the rules defined solely by natural persons to
automatically execute operations" are not AI systems (Recital 12, Regulation (EU)
2024/1689, <https://eur-lex.europa.eu/eli/reg/2024/1689/oj>). If we ever use machine
learning to score or rank people, we will assess the AI Act rules again before we do
it. [to confirm with lawyer]

## Your choice

The score is part of the service. You accept it with the terms at the end of setup:
there is no separate box to tick. We score only the sources you add. Remove a source,
and we stop reading it and delete what we collected from it. Delete your account in
Settings, and we delete your scores and all collected data, and companies no longer
see you.

Questions: [CONTACT EMAIL].

# How Scoring Works

NextCryptoJob gives you a score from 0 to 100 for each role you choose. This page says
where the number comes from and what to do if it looks wrong.

## In short

- We wrote our own formula for crypto work: each role counts what matters for that role.
- Same formula for everyone. The same data always gives the same score.
- Only public data, only from accounts and wallets you connect yourself.
- A source we cannot read is shown as a gap, never counted as zero.
- The number is plain arithmetic. Only the sentence that explains it is written by a language model.
- You pick your roles, and you can stop at any time.

## What we look at

| Source | What we measure |
|---|---|
| X | Followers; well-known crypto accounts that follow you; reactions to your own posts; how often you post |
| GitHub | Pull requests merged into other people's projects; stars; reviews; followers; commits in the last 12 months; projects with a live site |
| Wallets: Ethereum, Arbitrum, Base, Optimism, Solana | Wallet age; transactions; networks used; swaps |
| Hyperliquid | Recent trades and volume |
| YouTube | Subscribers; views of recent videos; how often you publish |
| Your website | How many posts and how recent |

We count reactions to your posts. We do not judge what you write, and we store counts and
dates, not the content. We never look at your age, gender, nationality or photo, at your
profit and loss, or at how much money sits in your wallets.

## How the number is built

1. **Each role has its main sources.** An engineer is measured mainly on GitHub, a trader
   on trading, media roles on X or YouTube. Some roles use two.
2. **A role needs its main source.** Without it we show "not enough data" instead of a low
   score.
3. **Extras only add.** Other sources add up to 10 bonus points. A source you did not
   connect never takes points away.
4. **Missing is not zero.** A source that does not answer or has too little data is shown
   as a gap, with the reason.
5. **Big numbers are compressed.** Going from 0 to 1,000 followers counts more than going
   from 100,000 to 101,000. Scales are set so the strongest people in the industry land at
   90 to 100.
6. **The score is capped at 100**, main part plus bonus.
7. **We test a formula before switching it on**, against a reference set of people whose
   level was judged by hand.

## Roles

Scored now: Engineer, Security auditor, DevRel, Data and research, Product or project
manager, BD and partnerships, Marketing and content, Creator or KOL, Community, Trader.

Not scored yet, because public data does not show the work: Designer, Operations and
support, Finance, Legal and compliance, HR and recruiting. You can still pick them, and we
send you jobs for them; you just do not get a score for them.

## Level and coverage

Your level is 1 to 10: the score divided by 10, rounded down, plus 1. A score of 67 is
level 7. Next to the score we show coverage: how much of the role's main part rests on
real data. Connecting more sources raises it.

Your score page shows the score for each role, every source with its weight and points,
the reason for any gap, the formula version, and what you could connect to show more.

## Refresh and limits

We reread your sources about once a week, and your score changes when your public activity
changes or when we release a new formula version. Known limits: selling tokens you received
as a gift can count as a swap, and we do not resolve ENS or SNS names, so paste the address.

## Questions

A score that looks wrong, or anything else about it: hello@nextcryptojob.xyz. A person reads
it and answers. What we store, who sees your score and your rights over it: see the
[privacy policy](/privacy).

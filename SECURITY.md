# Security

## Reporting a vulnerability

Write to hello@nextcryptojob.xyz with "security" in the subject, or open a private advisory through
GitHub ("Security" tab, "Report a vulnerability"). Please do not open a public issue for anything that
exposes candidate data.

We answer within three working days, tell you what we found, and credit you when the fix ships if you
want that. There is no paid bounty.

## What we care about most

- Access to a candidate profile, contacts or raw source data without the candidate's consent.
- Company access to the CRM without a paid period, or a payment counted twice.
- Anything that lets one account act as another (session, email code, Telegram sign-in, account merge).
- Scoring data that can be forged from outside, in a way our formula would trust.

## What is out of scope

- Self-reported sources: we say on every card that X, GitHub, wallets and sites are typed by the person
  and not proof of ownership. Reporting that "someone can enter a wallet that is not theirs" is a
  product decision, not a vulnerability. Cards can be reported and taken down.
- Rate limits hit with a residential proxy pool, clickjacking on pages without actions, missing security
  headers with no exploit path, or reports from an automated scanner with no working request.

## Keys and money

We hold no private keys and no card data. Company payments arrive as USDC on Solana to one public
address kept in the Worker configuration; access is granted only after the Worker reads that transfer
on chain.

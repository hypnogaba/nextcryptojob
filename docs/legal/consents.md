# NextCryptoJob In-Product Consent Texts

> **DRAFT. Not in force. For review by a French lawyer before launch.**
> This text is not legal advice. Points marked "[to confirm with lawyer]" are open.
> Version of this file: 0.3 (draft), 2026-09-14.

These are the exact short texts shown in the product. Since 2026-09-14 (owner decision,
third test round: "signing two documents is too much, using the service means agreeing")
the setup has no consent boxes at all. The last button of setup accepts the terms
(section 1). The score and the two "companies" settings come with the terms and can be
turned off in Settings as easily as they were set (art. 7(3) GDPR,
<https://gdpr-info.eu/art-7-gdpr/>).

Links point to the public pages. [to confirm product: final URL paths]

## Rules for all consents

- Show each text next to its own switch or button. Never bundle two consents in one click.
- Do not make the account or the job search depend on a consent that is not needed for it (art. 7(4) GDPR).
- Store a record for each change: `user_id`, `consent_key`, `version`, `text_sha256`, `given` or `withdrawn`, `timestamp`, `channel` (web or Telegram). This lets us show that consent was given (art. 7(1) GDPR).
- A new version of a text that changes its meaning needs new consent. A pure wording fix does not. [to confirm with lawyer]
- Candidates can use the account and the job digest without adding any source; then there is nothing to score.

## 1. Terms acceptance at the end of setup (since 2026-09-14)

- **Key:** `terms`
- **Version:** `terms-0.2` (the version of the Terms for Candidates; the Privacy Policy is part of them).
- **Where:** under the last button of setup ("How should we send your jobs?", Continue). No checkbox.
- **Legal basis:** contract, art. 6(1)(b) GDPR.

> By continuing you agree to the [Terms](https://nextcryptojob.xyz/terms) and [Privacy](https://nextcryptojob.xyz/privacy).

**What is recorded** (one batch, `acceptTerms` in `web/src/lib/account/settings.ts`):

- one event in `consent_events`: `terms`, granted, with the terms version;
- the state rows in `consents`: `terms`, and the two "companies" settings `visibility` and `contact` with the same terms version, both on. These two come with the terms, so they have no events of their own. They are written only if the person has not chosen them in Settings before; a choice made in Settings is kept.

| | `terms` | `visibility` | `contact` | `users.visible_to_companies` | `users.contact_mode` |
|---|---|---|---|---|---|
| Continue at the end of setup | granted 1, event | granted 1 | granted 1 | 1 | `direct` |

Pressing Continue again with the same terms version writes nothing. Any later change in
Settings writes its own event (sections 2 and 3b).

**The score** is part of the service accepted here. It uses only the sources the person
adds. There is no separate scoring box any more.

## 1a. Scoring box (until 2026-09-14)

- **Key:** `scoring`, **version** `v1`. No longer shown. Existing records stay valid: a person with a granted `scoring` record is scored like a person with `terms`.

> I agree that NextCryptoJob computes my score from the public data I connected.

## 2a. Companies box on the last setup step (2026-09-14, before the third test round)

- **Keys:** `visibility` and `contact`, **version** `welcome.v1`. No longer shown: the defaults now come with the terms (section 1). Records made with `welcome.v1` stay as they are.

## 2. Visibility to companies

- **Key:** `visibility`
- **Version:** `visibility.v1`
- **Where:** the "Show me to companies" switch in Settings and on the score page.
- **Default:** on for new candidates (section 1); off for candidates who signed up before 2026-09-14 and never switched it on.
- **Requires:** `terms` or an older `scoring` record (no score, nothing to show).
- **Legal basis:** contract, art. 6(1)(b) GDPR, with an opt-out at any time.

> Show me to paying companies: they can see and filter by my score, roles, level, networks and verification badges, and, while Show my Telegram directly is also on, my Telegram, X, GitHub, YouTube, website and wallet addresses. They never see my raw data. [What companies see](https://nextcryptojob.xyz/privacy#companies)

**Help text under the switch (not part of the consent):**

> While this is off, your profile is hidden. When it is on, only companies with a paid account can find you.

## 3. Contact sharing

Two modes. The candidate picks one. Since 2026-09-14 "direct" is the default for new
candidates (section 1); before that it was "Only after I approve".

### 3a. Per request

- **Key:** `contact.request`
- **Version:** `contact.request.v1`
- **Where:** each introduction request, by email, Telegram or on the site.
- **Legal basis:** consent, art. 6(1)(a) GDPR, given for one company and one role.

> Share my [Telegram handle / email] with [Company name] for the role "[Role]"? [What happens next](https://nextcryptojob.xyz/privacy#contact)

Buttons: `Yes, share` and `No`. "No" sends no data to the company.
[to confirm product: which contact channels a candidate can share]

### 3b. Direct mode

- **Key:** `contact.direct` (stored as `contact`)
- **Version:** `contact.direct.v1` (stored as `v1`; `welcome.v1` or the terms version when it came with setup)
- **Where:** Settings, the "Show my Telegram directly" switch in the "Show me to companies" panel. Turning it off falls back to 3a.
- **Default:** on for new candidates (section 1).
- **Requires:** `visibility`, and a Telegram username. Without a username the mode waits: companies see "Request intro" (3a), and the email is never shown in this mode.
- **Legal basis:** contract, art. 6(1)(b) GDPR, with an opt-out at any time.

> Show my Telegram handle to every paying company that can see my profile, without asking me first. [What happens next](https://nextcryptojob.xyz/privacy#contact)

**Note shown after switching off:**

> Companies that already saw your handle keep it under their own responsibility. They may use it only for recruiting.

## 4. Job digest by email

- **Key:** `digest.email`
- **Version:** `digest.email.v1`
- **Where:** first sign-in (for email sign-in), Settings.
- **Default:** off. [to confirm with lawyer: opt-in required, or contract basis enough]
- **Legal basis:** consent, art. 6(1)(a) GDPR; also covers art. L34-5 French Postal and Electronic Communications Code (<https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042155961/>) because the digest can include jobs from paying companies.

> Send me a daily email with up to 5 jobs that match my roles, including jobs posted by paying companies. [Privacy](https://nextcryptojob.xyz/privacy#digest)

Every digest email has a one-click "Unsubscribe" link, which withdraws this consent.

## 5. Job digest by Telegram

- **Key:** `digest.telegram`
- **Version:** `digest.telegram.v1`
- **Where:** first sign-in (for Telegram sign-in), Settings.
- **Default:** off.
- **Legal basis:** same as 4.

> Send me a daily Telegram message with up to 5 jobs that match my roles, including jobs posted by paying companies. [Privacy](https://nextcryptojob.xyz/privacy#digest)

Every digest message has a "Stop" button.

## 6. Public card page (optional, if the card is not public by default)

- **Key:** `card.public`
- **Version:** `card.public.v1`
- **Where:** the card screen, before the "Share on X" button.
- **Default:** off.
- **Legal basis:** consent, art. 6(1)(a) GDPR. [to confirm product behaviour and with lawyer]

> Publish my card at a public link that shows my score, role and level, with no wallets or links. [Privacy](https://nextcryptojob.xyz/privacy#card)

## Not consents (for clarity)

These are not consent texts and must not be shown as consent checkboxes:

- **Terms acceptance.** See section 1: a line under the button, not a checkbox.
- **Age.** "I am 18 or older." [to confirm with lawyer]
- **Wallet signature.** Signing a message to verify a wallet is an action, not a consent. Text: "Sign a message to prove this wallet is yours. This does not move funds or give any permission."

## Version history

| Version | Date | Change |
|---|---|---|
| all `.v1` | 2026-09-12 | First draft |
| `welcome.v1` | 2026-09-14 | Companies box on the last setup step, pre-ticked (section 2a) |
| `terms-0.2` | 2026-09-14 | No boxes: the last button accepts the terms; score and companies settings come with them (section 1) |

# NextCryptoJob In-Product Consent Texts

> **DRAFT. Not in force. For review by a French lawyer before launch.**
> This text is not legal advice. Points marked "[to confirm with lawyer]" are open.
> Version of this file: 0.2 (draft), 2026-09-14.

These are the exact short texts shown in the product. Each one is a separate choice.
None is pre-ticked, except the "companies" box on the last setup step (section 2a, owner
decision 2026-09-14). Each can be withdrawn in Settings as easily as it was given
(art. 7(3) GDPR, <https://gdpr-info.eu/art-7-gdpr/>).

Links point to the public pages. [to confirm product: final URL paths]

## Rules for all consents

- Show each text next to its own switch or button. Never bundle two consents in one click.
- Do not make the account or the job search depend on a consent that is not needed for it (art. 7(4) GDPR).
- Store a record for each change: `user_id`, `consent_key`, `version`, `text_sha256`, `given` or `withdrawn`, `timestamp`, `channel` (web or Telegram). This lets us show that consent was given (art. 7(1) GDPR).
- A new version of a text that changes its meaning needs new consent. A pure wording fix does not. [to confirm with lawyer]
- Candidates can use the account and the job digest without the scoring consent. [to confirm product behaviour]

## 1. Scoring (profiling)

- **Key:** `scoring`
- **Version:** `scoring.v1`
- **Where:** first sign-in, before the first score; Settings.
- **Default:** off.
- **Legal basis:** consent, art. 6(1)(a) GDPR, and explicit consent under art. 22(2)(c) GDPR (<https://gdpr-info.eu/art-22-gdpr/>).

> I agree that NextCryptoJob collects public data from the accounts and wallets I connect and uses an automated formula to score me for the roles I choose (profiling). [How scoring works](https://nextcryptojob.xyz/how-scoring-works)

**On withdrawal:** stop collection; delete scores and source data; switch off visibility.

Withdrawal text in Settings:

> Stop scoring me. My scores and collected data will be deleted, and companies will no longer see me.

## 2a. Companies box on the last setup step (new candidates, since 2026-09-14)

- **Keys:** `visibility` and `contact` (two rows in `consents`, two events in `consent_events`).
- **Version:** `welcome.v1` for both.
- **Where:** the consent step at the end of the setup brief, below the scoring consent. First pass only: editing the step later links to Settings and changes nothing.
- **Default:** ticked (owner decision 2026-09-14). The box and its text are visible next to the scoring box, never hidden behind a link.
- **Requires:** `scoring` (the same submit gives it; without it nothing about companies is written).
- **Legal basis:** consent, art. 6(1)(a) GDPR.

> Companies hiring on NextCryptoJob can find you and see your score and Telegram handle. You can turn this off any time in Settings.

Secondary option under it (unticked by default):

> Only after I approve each company

Help text (not part of the consent): with a Telegram username, "Companies see @handle. Never your wallet addresses or email."; without one, "You have no Telegram username yet, so companies send you an intro request first. We never show your email without your yes."

**What is recorded** (one batch, `applyWelcomeSharing` in `web/src/lib/account/settings.ts`):

| Choice | `visibility` | `contact` | `users.visible_to_companies` | `users.contact_mode` |
|---|---|---|---|---|
| Box ticked (default) | granted 1 | granted 1 | 1 | `direct` |
| Box ticked + "Only after I approve each company" | granted 1 | granted 0 | 1 | `approval` |
| Box unticked | granted 0 | granted 0 | 0 | `approval` |

A refusal is recorded as a `granted = 0` event too, so the history shows that the choice was offered.
Existing candidates are not changed: their current settings stay as they are.

## 2. Visibility to companies

- **Key:** `visibility`
- **Version:** `visibility.v1`
- **Where:** the "Show me to companies" switch in Settings and on the score page.
- **Default:** on for new candidates (section 2a); off for candidates who signed up before 2026-09-14 and never switched it on.
- **Requires:** `scoring` (no score, nothing to show).
- **Legal basis:** consent, art. 6(1)(a) GDPR.

> Show me to paying companies: they can see and filter by my score, roles, level, networks and verification badges, but never my wallet addresses or raw data. [What companies see](https://nextcryptojob.xyz/privacy#companies)

**Help text under the switch (not part of the consent):**

> While this is off, your profile is hidden. When it is on, only companies with a paid account can find you.

## 3. Contact sharing

Two modes. The candidate picks one. Since 2026-09-14 "direct" is the default for new
candidates (section 2a); before that it was "Only after I approve".

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
- **Version:** `contact.direct.v1` (stored as `v1`; `welcome.v1` when given on the setup step)
- **Where:** Settings, the "Show my Telegram directly" switch in the "Show me to companies" panel. Turning it off falls back to 3a.
- **Default:** on for new candidates (section 2a).
- **Requires:** `visibility`, and a Telegram username. Without a username the mode waits: companies see "Request intro" (3a), and the email is never shown in this mode.
- **Legal basis:** consent, art. 6(1)(a) GDPR.

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

- **Terms acceptance.** "By continuing you accept the [Terms](https://nextcryptojob.xyz/terms) and have read the [Privacy Policy](https://nextcryptojob.xyz/privacy)." Legal basis for the account is the contract, art. 6(1)(b) GDPR.
- **Age.** "I am 18 or older." [to confirm with lawyer]
- **Wallet signature.** Signing a message to verify a wallet is an action, not a consent. Text: "Sign a message to prove this wallet is yours. This does not move funds or give any permission."

## Version history

| Version | Date | Change |
|---|---|---|
| all `.v1` | 2026-09-12 | First draft |
| `welcome.v1` | 2026-09-14 | Companies box on the last setup step, pre-ticked (section 2a) |

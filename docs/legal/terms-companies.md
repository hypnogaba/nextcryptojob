# NextCryptoJob Terms for Companies

These terms are a contract between NextCryptoJob, sole trader, France,
hello@nextcryptojob.xyz, hello@nextcryptojob.xyz ("we", "us") and the company or agency that subscribes to
NextCryptoJob ("you"). They apply to the CRM, the job posting tools, the REST API, the
MCP server and paid requests through x402.

## 1. Who can subscribe

- The service is for businesses only. You confirm that you act for a business, not as a consumer.
- The person who accepts these terms confirms that they may bind the company.
- Recruiting agencies must apply. We approve agencies by hand and may refuse without giving a reason.
- You must give true company information and keep it up to date.

## 2. Words used here

- **Candidate**: a person with a NextCryptoJob account.
- **Visible candidate**: a candidate whose "Show me to companies" setting is on.
- **Profile data**: what we show you about a visible candidate: score, roles, level, networks, verification badges, experience, remote or city, and similar fields.
- **Contact data**: the contact a candidate shares with you after approving your request, or at once if their "Show my Telegram directly" setting is on.
- **Candidate data**: profile data, contact data and anything else you receive about candidates through the service.
- **Your data**: pipeline stages, notes, tags, saved searches and jobs that your team creates.
- **Agent**: software, including an AI agent, that uses the API or MCP server for you.

## 3. Your account and team

- You can invite team members. You are responsible for everything your members and your agents do.
- Each member must use their own login. Do not share logins.
- Remove members who leave your company.

## 4. What you may do with candidate data

You may use candidate data **only to recruit** for real, open roles. For approved
agencies, this means real roles of your clients.

## 5. What you must not do

You must not:

- export, download in bulk, copy into another database, or keep candidate data outside the service, except contact data after the candidate approved contact;
- scrape the site or use the API beyond the documented use and rate limits;
- sell, rent, license or give candidate data to anyone;
- use candidate data for marketing, for products other than recruiting, or to train or evaluate machine learning models;
- try to identify a candidate before they approve contact, for example by matching their networks or activity with blockchain explorers or social networks;
- contact a candidate outside the introduction flow before they approve;
- send introduction requests in bulk or without a real role;
- search, filter, rank or decide on candidates based on origin, sex, age, family situation, pregnancy, disability, health, religion, political opinion, union activity, sexual orientation, gender identity, physical appearance, family name, place of residence or any other ground listed in art. L1132-1 French Labour Code (<https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000042026716>);
- ask a candidate for any payment, deposit or fee. French law forbids fees from job seekers for placement services (art. L5321-3 French Labour Code, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031643464>). This applies to agencies too.

## 6. A person must decide

The score is an input to your judgment. It is not a decision.

- You must not decide to hire, reject, or end a recruitment process with a candidate based solely on automated processing, including the score, a filter or an agent's output (art. 22 GDPR, <https://gdpr-info.eu/art-22-gdpr/>).
- Before such a decision, a person in your team who has the authority to change it must look at the candidate's information.
- Your agents may search, build shortlists and send introduction requests. They must not send rejections or offers without review by a person.
- French law requires you to tell candidates, before you use them, which recruitment methods and techniques you use (art. L1221-8 French Labour Code, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006900847>). If you use NextCryptoJob scores, tell the candidate.
- Information you ask from candidates must serve only to assess their ability for the job (art. L1221-6, <https://www.legifrance.gouv.fr/codes/id/LEGISCTA000006189415/>).

## 7. Data protection roles

- **Before contact.** We are the controller of profile data. We make it available to you in the service under these terms. You must treat it as confidential and use it only as section 4 allows.
- **After contact.** When a candidate approves your request (or chose direct contact), you receive their contact data. From that moment you are an independent controller of the contact data and of your own recruitment process. You must:
  - give the candidate the information required by art. 14 GDPR (<https://gdpr-info.eu/art-14-gdpr/>), at the latest at your first message to them;
  - keep their data no longer than 2 years after your last contact with them, unless they agree to longer, as the CNIL recommends (<https://www.cnil.fr/fr/cnil-direct/question/recrutement-un-employeur-peut-il-conserver-mon-dossier>);
  - answer their rights requests yourself.
- **Your data in the CRM.** For notes, tags and pipeline stages that your team writes about candidates, you decide why and how they are processed. We store them for you as your processor under the data processing terms in Annex A (art. 28 GDPR, <https://gdpr-info.eu/art-28-gdpr/>).
- **When a candidate hides their profile or deletes their account**, their profile data disappears from your view. Your notes about that candidate are deleted too.
- Write notes that are factual and professional. Candidates can ask to see data about them.

## 8. Confidentiality

- Keep candidate data and anything we mark as confidential secret. Share it only with team members who need it for recruiting.
- These duties continue after the contract ends.

## 9. Security

- Keep API keys secret. Do not put them in public code or client-side apps. Rotate a key at once if it leaks.
- Tell us within 48 hours at hello@nextcryptojob.xyz if you suspect unauthorised access to your account, your keys or candidate data.
- We keep a log of access to candidate data. We may review it to check that you follow these terms.

## 10. Subscription and payment

- **Price.** 100 USDC per 30 days per company, unless your order says otherwise.
- **How you pay.** In crypto only: USDC on Solana, to the address shown in your billing page.
  Each payment opens 30 days of access, counted from the moment the transfer is confirmed on
  chain. Nothing renews by itself: you pay again when you want the next 30 days.
- **Refunds.** We do not refund part of a paid period, except where the law requires it or where
  we ended the contract without a fault on your side.
- **Late payment.** For invoices paid late, penalties apply at the statutory rate and a fixed recovery fee of EUR 40 is due (art. L441-10 French Commercial Code, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000038414392>; art. D441-5, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000043197457>).
- **Price changes.** We tell you at least 30 days before a price change. You can cancel before it applies.

## 11. API, MCP and x402

- **Same rules.** Everything your agents do through the API, the MCP server or x402 is subject to these terms, the same as actions in the CRM.
- **API keys.** API keys work within your subscription.
- **x402.** You can pay per request in USDC through the x402 protocol, at the prices shown in each payment request (HTTP 402 response).
  - A payment is final once confirmed on the blockchain. You pay the network fees.
  - If we accept a payment and fail to deliver the result, we credit or refund the amount.
  - We do not hold funds for you. We are not a crypto service provider for you.
  - Contact data is never returned through x402 or the API unless the candidate approved contact.
- **Rate limits.** We set limits on requests per minute and per day [NUMBERS to set]. We may slow or block traffic above them.
- **Identification.** Your agents must identify your company in each request (through the key or the account linked to the payment).
- **Changes.** We may change the API. We announce breaking changes at least 30 days ahead, except for urgent security fixes.

## 12. Job posts

- Post only real, open jobs. Describe them accurately, including pay where you can.
- A job post must not mention any ground listed in art. L1132-1 French Labour Code (art. L5321-2, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006903780>).
- For jobs performed in France, or offered by a French employer, French law has rules on the language of job offers (art. L5331-4 French Labour Code, <https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006903796>). You are responsible for following them.
- A job post must not ask candidates for any payment.
- We may show your jobs in candidate digests and post them on our X account.
- We may refuse or remove a job post that breaks these terms or the law. We tell you why.

## 13. Suspension and termination

- **You** can end the contract at any time by cancelling your subscription.
- **We** may suspend access at once, and then end the contract, if you:
  - scrape, export or resell candidate data;
  - discriminate, or ask candidates for money;
  - try to identify candidates before contact;
  - do not pay after a reminder;
  - put the security of the service or of candidates at risk.
- For other breaches, we warn you and give you 15 days to fix them.
- **When the contract ends**, your access stops. You must delete profile data you still hold outside contacted candidates. We delete your data (Annex A) within 30 days, except invoices, which we keep 10 years by law.

## 14. Liability

- The score is an indication based on public data. We do not guarantee its accuracy, or that any candidate is fit for your role, or any hiring result.
- Our total liability under this contract is limited to the fees you paid in the 12 months before the event. This limit does not apply to fraud, gross negligence, or where the law forbids it.
- You are liable for your use of candidate data, for your agents and for your job posts. You will cover our losses if a claim results from your breach of sections 4 to 9 or 12.

## 15. Changes to these terms

We tell you about changes at least 30 days before they apply. If you do not agree, you
can cancel before that date.

## 16. Law and courts

French law applies. Disputes go to the courts of [CITY], France.

---

## Annex A. Data processing terms (art. 28 GDPR)

For your data in the CRM (notes, tags, pipeline stages, saved searches, your jobs):

1. **Subject and duration.** We store and display your data so that your team can run its recruitment process, for as long as the contract lasts.
2. **Instructions.** We process your data only on your documented instructions, which are these terms and your use of the service.
3. **Confidentiality.** Only the operator of NextCryptoJob can access your data, and only to run, support or secure the service.
4. **Security.** We apply the measures in the Privacy Policy, section 14.
5. **Sub-processors.** Cloudflare (hosting and database). We tell you 30 days before we add or replace a sub-processor. You can object.
6. **Assistance.** We help you answer candidates' rights requests and meet your duties under arts. 32 to 36 GDPR.
7. **Breach.** We tell you without undue delay after we become aware of a breach that affects your data.
8. **End.** When the contract ends, we delete your data within 30 days. You can export it before.
9. **Audits.** We give you the information needed to show compliance with art. 28 GDPR.
10. **Transfers.** Hosting may involve transfer to the USA under the EU-US Data Privacy Framework or standard contractual clauses.

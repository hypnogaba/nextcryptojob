/**
 * Питання й відповіді /faq. Один перелік і для сторінки (app/faq/page.tsx), і для FAQPage JSON-LD
 * (faqJsonLd): текст живе лише тут, тож розмітка для пошуку не розходиться з тим, що бачить людина.
 * Абзац = масив частин: рядок або посилання { text, href }.
 */

export type FaqPart = string | { text: string; href: string };
export type FaqItem = { q: string; a: FaqPart[][] };

export const FAQ: readonly FaqItem[] = [
  {
    q: "How does NextCryptoJob work?",
    a: [
      [
        "Four steps. You tell us in your own words what job you want. We read the sources you connect, your X, your GitHub and your wallets, and turn them into a score for the role you want, with the full breakdown. We check crypto jobs every day and send you the ones that match, each with the reason it matched. You apply yourself, with one click, and the jobs you save stay in your account.",
      ],
    ],
  },
  {
    q: "Do I need a CV or a cover letter?",
    a: [
      [
        "No. We never ask for a CV, a cover letter or a motivation letter. Your profile is built from work you have already done and published, so there is nothing to write from scratch. A few short questions about the job you want is all we need.",
      ],
    ],
  },
  {
    q: "Where do the jobs come from, and how fresh are they?",
    a: [
      [
        "From the career pages of about 320 crypto employers, from crypto job boards, and from companies that post with us. We read every source once a day, keep jobs posted in the last 30 days, and drop duplicates, so the list you see is current, not a stale archive.",
      ],
    ],
  },
  {
    q: "Do you help me apply?",
    a: [
      [
        "We do the finding, the matching and the sorting: every job we send says why it fits your roles, your place and the pay you asked for. Applying stays with you, one click from the job page to the company, and your profile link is there to share instead of a CV. We do not apply on your behalf and we never message a company as you.",
      ],
    ],
  },
  {
    q: "What do you read?",
    a: [
      [
        "Only what is public: your posts on X, your GitHub activity, and your wallets' on-chain history. We never read private messages or anything you have not connected yourself.",
      ],
    ],
  },
  {
    q: "How does the score work?",
    a: [
      [
        "Each connected source becomes a 0 to 100 number, weighted by role, then combined into one score and a level from 1 to 10. The full breakdown, with sources and weights, is on ",
        { text: "How your score works", href: "/how-scoring-works" },
        ", and you can see it live at ",
        { text: "/scoring", href: "/scoring" },
        ".",
      ],
    ],
  },
  {
    q: "What about privacy, and deleting my account?",
    a: [
      [
        "Read our ",
        { text: "privacy policy", href: "/privacy" },
        " for what we store and why. You can delete your account, sources, scores, cards and consent history at any time from ",
        { text: "Settings", href: "/settings" },
        ". Cards you already shared stop updating but the public link keeps working until you delete it too.",
      ],
    ],
  },
  {
    q: "Why do you ask for a wallet address?",
    a: [
      [
        "A wallet's on-chain history (age, transactions, chains, trading) is public and hard to fake, so it counts toward roles like Trader, or as a bonus for most roles. We only read the address you paste; we never ask for a signature, a seed phrase or access to funds.",
      ],
    ],
  },
  {
    q: "How much does this cost?",
    a: [["NextCryptoJob is free for candidates: connecting sources, getting a score, a card, and the daily job digest."]],
  },
  {
    q: "How do I contact you?",
    a: [
      [
        "Write to ",
        { text: "hello@nextcryptojob.xyz", href: "mailto:hello@nextcryptojob.xyz" },
        " or use the ",
        { text: "contact form", href: "/contact" },
        ".",
      ],
    ],
  },
];

/** Відповідь без розмітки: те, що людина читає, одним рядком на абзац. */
export function faqPlainText(a: FaqPart[][]): string {
  return a.map((p) => p.map((x) => (typeof x === "string" ? x : x.text)).join("")).join("\n");
}

/** FAQPage для пошуку зі того самого переліку. */
export function faqJsonLd(items: readonly FaqItem[] = FAQ) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: faqPlainText(i.a) },
    })),
  };
}

import type { Metadata, Viewport } from "next";
import { Funnel_Display, Funnel_Sans } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SiteNotice } from "@/components/site-state";
import "./globals.css";

// Funnel Display для заголовків і чисел, Funnel Sans для тексту (напрям «Payday»).
// Обидва змінні, OFL. Код і адреси йдуть системним моноширинним.
const display = Funnel_Display({
  subsets: ["latin", "latin-ext"],
  variable: "--nf-display",
  display: "swap",
});

const text = Funnel_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--nf-text",
  display: "swap",
});

export const metadata: Metadata = {
  // SITE_URL задає адресу для абсолютних посилань (Open Graph, canonical).
  // Поки DNS не готовий, workers.dev може передати свою; за замовчуванням домен.
  metadataBase: new URL(process.env.SITE_URL ?? "https://nextcryptojob.xyz"),
  title: {
    default: "NextCryptoJob: crypto and web3 jobs matched to your proof of work",
    template: "%s | NextCryptoJob",
  },
  // Своя адреса для кожної сторінки: './' Next розгортає відносно поточного шляху. Без цього
  // адреси з мітками (?utm=…) і друга адреса на workers.dev виглядають для пошуку як копії сайту.
  alternates: { canonical: "./" },
  description:
    "Crypto jobs that fit you. Answer a short brief and get a few matching jobs every day by Telegram or email, free.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${text.variable}`}
    >
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg border border-line bg-surface text-sm font-medium text-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-4 focus:py-3"
        >
          Skip to content
        </a>
        <SiteHeader />
        <SiteNotice />
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Familjen_Grotesk } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SiteNotice } from "@/components/site-state";
import "./globals.css";

// Big Shoulders для чисел і заголовків (вузький, як табло), Familjen Grotesk для
// тексту. Обидва змінні, OFL. Код і адреси йдуть системним моноширинним.
const display = Big_Shoulders({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  variable: "--nf-display",
  // Для Big Shoulders у Next немає метрик запасного шрифту.
  adjustFontFallback: false,
  display: "swap",
});

const text = Familjen_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--nf-text",
  display: "swap",
});

export const metadata: Metadata = {
  // SITE_URL задає адресу для абсолютних посилань (Open Graph, canonical).
  // Поки DNS не готовий, workers.dev може передати свою; за замовчуванням домен.
  metadataBase: new URL(process.env.SITE_URL ?? "https://nextcryptojob.xyz"),
  title: {
    default: "NextCryptoJob",
    template: "%s | NextCryptoJob",
  },
  description:
    "Crypto jobs that fit you. Answer a short brief and get a few matching jobs every day by Telegram or email, free.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eceef1" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1829" },
  ],
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

// Із чого складається бал кожного джерела (формула v6, engine/src/formula/sources.ts) для сторінки
// ваг (власник 16.09, c5: видно вагу ончейн-активності). Числа ті самі, що в рушії; тест
// source-parts.test.ts рахує рушієм і тримає їх разом.
import type { SourceKey } from "./recipes";

export type SourcePart = {
  label: string;
  /** Частка в балі джерела; частини одного джерела дають 100. */
  weight: number;
  /** Де частина досягає максимуму; null для частини без шкали. */
  top: string | null;
  /** log: перші кроки важать більше за останні; linear: рівними кроками. */
  scale: "log" | "linear" | null;
};

type Direct = Exclude<SourceKey, "media" | "output">;

export const SOURCE_PARTS: Record<Direct, readonly SourcePart[]> = {
  gh_eng: [
    { label: "Pull requests merged into other people's projects", weight: 35, top: "1,000", scale: "log" },
    { label: "Stars on your own projects", weight: 25, top: "5,000", scale: "log" },
    { label: "Code reviews, last 12 months", weight: 15, top: "300", scale: "log" },
    { label: "Followers", weight: 15, top: "3,000", scale: "log" },
    { label: "Commits, last 12 months", weight: 10, top: "2,000", scale: "log" },
  ],
  gh_builder: [
    { label: "Projects you pushed to, last 12 months", weight: 40, top: "12", scale: "linear" },
    { label: "Projects with a live site", weight: 30, top: "4", scale: "linear" },
    { label: "Commits, last 12 months", weight: 30, top: "1,500", scale: "log" },
  ],
  x: [
    { label: "Well-known crypto accounts that follow you", weight: 30, top: "1,000", scale: "log" },
    { label: "Followers", weight: 15, top: "500,000", scale: "log" },
    { label: "Likes and reposts per post", weight: 15, top: "1,500", scale: "log" },
    { label: "Views per post", weight: 15, top: "150,000", scale: "log" },
    { label: "Replies per post", weight: 15, top: "150", scale: "log" },
    { label: "Your own posts per 30 days", weight: 10, top: "20", scale: "linear" },
  ],
  yt: [
    { label: "Subscribers", weight: 45, top: "1,000,000", scale: "log" },
    { label: "Views of recent videos", weight: 35, top: "100,000", scale: "log" },
    { label: "Videos, last 90 days", weight: 20, top: "12", scale: "linear" },
  ],
  onchain: [
    { label: "Wallet age", weight: 35, top: "6 years", scale: "linear" },
    { label: "Transactions", weight: 35, top: "10,000", scale: "log" },
    { label: "Networks used", weight: 30, top: "6", scale: "linear" },
  ],
  trading: [
    { label: "Trades and swaps", weight: 60, top: "10,000", scale: "log" },
    { label: "Hyperliquid volume", weight: 30, top: "$1B", scale: "log" },
    { label: "Networks you trade on", weight: 10, top: "6", scale: "linear" },
  ],
  site: [
    { label: "The site answers", weight: 30, top: null, scale: null },
    { label: "Posts in the feed", weight: 40, top: "100", scale: "log" },
    { label: "Posts, last 90 days", weight: 20, top: "8", scale: "linear" },
    { label: "Pages in the sitemap", weight: 10, top: "150", scale: "log" },
  ],
  audits: [
    { label: "Earnings from audit contests", weight: 60, top: "$1M", scale: "log" },
    { label: "High-severity findings", weight: 40, top: "150", scale: "log" },
  ],
  dune: [
    { label: "Pull requests merged into Dune Spellbook", weight: 70, top: "300", scale: "log" },
    { label: "Of them, last 12 months", weight: 30, top: "50", scale: "log" },
  ],
};

/** Джерела, що беруть найкраще з інших. */
export const COMBINED_SOURCES: Record<"media" | "output", string> = {
  media: "The higher of your X and YouTube scores.",
  output: "The highest of your Website, GitHub and Dune scores.",
};

/** Колонки таблиці ваг: усі джерела, які є в рецептах ролей, у порядку показу. */
export const WEIGHT_COLUMNS: readonly SourceKey[] = ["gh_eng", "gh_builder", "x", "media", "output", "onchain", "trading", "site", "audits"];

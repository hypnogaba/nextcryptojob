// Посилання «поділитись у X» (intent), без API і без ключів.
import { ROLES, type RoleKey } from "./roles";
import { displayScore, levelFor, MAX_LEVEL } from "./tiers";

type Shareable = { slug: string; role: RoleKey; score: number };

export function cardPath(slug: string): string {
  return `/c/${slug}`;
}

/** «I scored 72 as a Security auditor on NextCryptoJob. Level 8 of 10.» */
export function shareText(card: Pick<Shareable, "role" | "score">): string {
  return (
    `I scored ${displayScore(card.score)} ${ROLES[card.role].as} on NextCryptoJob. ` +
    `Level ${levelFor(card.score)} of ${MAX_LEVEL}.`
  );
}

export function xShareUrl(card: Shareable, origin: string | URL): string {
  const params = new URLSearchParams({
    text: shareText(card),
    url: new URL(cardPath(card.slug), origin).toString(),
  });
  // URLSearchParams пише пробіл як «+»; %20 розуміють усі клієнти X однаково.
  return `https://x.com/intent/post?${params.toString().replace(/\+/g, "%20")}`;
}

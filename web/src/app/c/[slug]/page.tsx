import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ScoreCard } from "@/components/score-card";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { cardPath, xShareUrl } from "@/lib/card/share";
import { cardView } from "@/lib/card/view";
import { loadCard, loadIsOwner, requestOrigin } from "./card-data";

// Публічна сторінка картки: єдине, що видно без входу. Лише бал, роль, рівень
// і ім'я для показу; ні гаманців, ні посилань, ні того, чий це акаунт.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) return { title: "Card not found", robots: { index: false, follow: false } };

  const view = cardView(card);
  const title = `${view.displayName}: ${view.roleName}, score ${view.score}`;
  const description =
    `${view.displayName} scored ${view.score} out of 100 ${ROLES[card.role].as} on NextCryptoJob. ` +
    `Level ${view.level} of 10.`;
  const image = {
    url: `${cardPath(slug)}/opengraph-image`,
    width: 1200,
    height: 630,
    alt: view.summary,
  };

  return {
    metadataBase: await requestOrigin(),
    title,
    description,
    alternates: { canonical: cardPath(slug) },
    // Людина ділиться карткою в X сама; у пошуковиках її бал не потрібен.
    robots: { index: false, follow: true },
    openGraph: {
      type: "website",
      siteName: "NextCryptoJob",
      url: cardPath(slug),
      title,
      description,
      images: [image],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function CardPage({ params }: Props) {
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) notFound();
  const view = cardView(card);
  // Власник бачить «Share on X»; хто він, у HTML не потрапляє.
  const owner = await loadIsOwner(slug);
  const shareUrl = owner ? xShareUrl(card, await requestOrigin()) : null;

  return (
    <section className="mx-auto max-w-4xl px-4 pt-10 pb-20 sm:px-6 sm:pt-16 sm:pb-28">
      <ScoreCard view={view} />

      <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-md">
          <p className="text-ink-muted">
            Level {view.level} of 10 means a {view.roleName} score from {view.levelRange}. NextCryptoJob
            turns a public track record on X, GitHub and wallets into a score for a crypto role.
          </p>
          <p className="mt-3 font-mono text-xs text-ink-muted">
            Scored on {view.issuedOn}, formula {view.formulaVersion}
          </p>
        </div>
        {shareUrl ? (
          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
            <Button asChild size="lg" className="h-11 px-5 text-base">
              <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                Share on X
              </a>
            </Button>
            <Link
              href="/profile"
              className="inline-flex min-h-11 items-center text-sm font-medium text-ink-muted hover:text-ink"
            >
              Back to profile
            </Link>
          </div>
        ) : (
          <Button asChild size="lg" className="h-11 shrink-0 px-5 text-base">
            <Link href="/login">Get your own score</Link>
          </Button>
        )}
      </div>
    </section>
  );
}

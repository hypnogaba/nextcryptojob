import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CardBackFace } from "@/components/card/card-back";
import { CardFlip } from "@/components/card/card-flip";
import { CardFront } from "@/components/card/card-front";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { cardPath, xShareUrl } from "@/lib/card/share";
import { loadCardView, loadIsOwner, requestOrigin } from "./card-data";

// Публічна сторінка картки: єдине, що видно без входу. Бал, роль, рівень, ім'я
// для показу і розклад балу на звороті; ні гаманців, ні посилань, ні того, чий це акаунт.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const view = await loadCardView(slug);
  if (!view) return { title: "Card not found", robots: { index: false, follow: false } };

  const title = `${view.displayName}: ${view.roleName}, score ${view.score}`;
  const description =
    `${view.displayName} scored ${view.score} out of 100 ${ROLES[view.role].as} on NextCryptoJob. ` +
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
  const view = await loadCardView(slug);
  if (!view) notFound();
  // Власник бачить «Share on X» і картинки; хто він, у HTML не потрапляє.
  const owner = await loadIsOwner(slug);
  const shareUrl = owner ? xShareUrl(view, await requestOrigin()) : null;
  const meta = `Formula ${view.formulaVersion}, issued ${view.issuedOn}.`;

  return (
    <section className="mx-auto grid max-w-[1240px] items-start gap-12 px-[clamp(16px,4vw,56px)] pt-10 pb-24 sm:pt-16 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-20">
      <CardFlip
        className="mx-auto w-full max-w-[380px]"
        front={<CardFront face={view} draw />}
        back={<CardBackFace face={view} back={view.back} meta={meta} missing={view.backMissing} />}
      />

      <div className="grid max-w-[60ch] gap-6 lg:pt-4">
        <div className="grid gap-4">
          <h1 className="display text-title">
            {view.roleName}, rated {view.score}
          </h1>
          <p className="text-lg text-ink">
            {view.displayName}. Level {view.level} of 10, {view.tier.finishName.toLowerCase()} finish: a{" "}
            {view.roleName} score from {view.levelRange}.
          </p>
          <p className="text-ink-muted">
            NextCryptoJob turns a public track record on X, GitHub and wallets into a score for a crypto role. Flip
            the card to see every source, its weight and the points it added.
          </p>
          <p className="text-sm text-ink-muted">
            Issued on {view.issuedOn}, formula {view.formulaVersion}. The seal belongs to this card and gains a layer
            with every level.
          </p>
        </div>
        {shareUrl ? (
          <div className="grid gap-4 border-t border-line pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                  Share on X
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={`${cardPath(slug)}/share/wide`} download>
                  Image 16:9
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={`${cardPath(slug)}/share/tall`} download>
                  Image 4:5
                </a>
              </Button>
            </div>
            <p className="text-sm text-ink-muted">Attach an image to your post so the card shows at full size.</p>
            <Link
              href="/profile"
              className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
            >
              Back to profile
            </Link>
          </div>
        ) : (
          <div className="border-t border-line pt-6">
            <Button asChild size="lg">
              <Link href="/login">Get your own card</Link>
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

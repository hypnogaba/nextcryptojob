import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CardBackFace } from "@/components/card/card-back";
import { CardFront } from "@/components/card/card-front";
import { ShareOnX } from "@/components/card/share-on-x";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { cardPath, shareText, xShareUrl } from "@/lib/card/share";
import { isScoredRoleKey, recipeBonus, recipeCore } from "@/lib/roles/recipes";
import { loadCardView, loadIsOwner, requestOrigin } from "./card-data";
import { ReportForm } from "./report-form";

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
  const origin = await requestOrigin();
  // Клік іде через /go/share-x, який рахує funnel_days ('share_click', /admin/funnel) і
  // веде далі на x.com з тими самими параметрами (без відкритого редіректу: хост фіксований).
  const shareUrl = owner ? `/go/share-x${new URL(xShareUrl(view, origin)).search}` : null;
  const cardUrl = new URL(cardPath(slug), origin).toString();
  const meta = `Formula ${view.formulaVersion}, issued ${view.issuedOn}.`;
  const recipe = isScoredRoleKey(view.role)
    ? `How ${view.roleName} is scored: ${recipeCore(view.role)}. Bonus: ${recipeBonus(view.role)}.`
    : null;

  return (
    <section className="mx-auto grid max-w-[1280px] items-start gap-12 px-[clamp(16px,4vw,32px)] pt-6 pb-24 sm:pt-10 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-16">
      <div className="grid gap-6">
        <div className="rounded-[32px] border border-line bg-soft p-6 sm:p-10">
          <div className="ncj-card mx-auto max-w-[440px] -rotate-3">
            <CardFront face={view} draw spin />
          </div>
        </div>
        <CardBackFace face={view} back={view.back} meta={meta} missing={view.backMissing} recipe={recipe} />
      </div>

      <div className="grid max-w-[60ch] gap-6 lg:pt-4">
        <div className="grid gap-4">
          <h1 className="display text-title">
            {view.roleName}, rated {view.score}
          </h1>
          <p className="text-lg text-ink">
            {view.displayName}. Level {view.level} of 10, {view.tier.finishName.toLowerCase()} finish:{" "}
            {/^[aeiou]/i.test(view.roleName) ? "an" : "a"} {view.roleName} score from {view.levelRange}.
          </p>
          <p className="text-ink-muted">
            NextCryptoJob turns a public track record on X, GitHub and wallets into a score for a crypto role. Under
            the card you see every source, its weight and the points it added.
          </p>
          <p className="text-sm text-ink-muted">
            Issued on {view.issuedOn}, formula {view.formulaVersion}. The round seal belongs to this card and gains a ring
            with every level.
          </p>
          {view.selfReported ? (
            <p className="text-xs text-ink-muted" data-self-reported>
              Self-reported: the card owner added their X, GitHub and wallets themselves. We score public activity, we
              do not check who owns an account.
            </p>
          ) : null}
        </div>
        {shareUrl ? (
          <div className="grid gap-4 border-t border-line pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <ShareOnX text={shareText(view)} cardUrl={cardUrl} imageUrl={`${cardPath(slug)}/share/wide`} trackHref={shareUrl} />
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
            <Link
              href="/profile"
              className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-ink underline decoration-line-strong decoration-2 underline-offset-4 hover:decoration-ink"
            >
              Back to profile
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 border-t border-line pt-6">
            <Button asChild size="lg" className="w-fit">
              <Link href="/login">Get your own card</Link>
            </Button>
            <ReportForm slug={slug} />
          </div>
        )}
      </div>
    </section>
  );
}

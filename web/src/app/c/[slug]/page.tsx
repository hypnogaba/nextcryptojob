import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CardBackFace } from "@/components/card/card-back";
import { CardFront } from "@/components/card/card-front";
import { ShareOnX } from "@/components/card/share-on-x";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { cardPath, shareText, xShareUrl } from "@/lib/card/share";
import { getCardRedirect } from "@/lib/card/store";
import { db } from "@/lib/db";
import { isScoredRoleKey, recipeBonus, recipeCore } from "@/lib/roles/recipes";
import { loadCardView, loadIsOwner, loadProfileView, requestOrigin } from "./card-data";
import { Proof } from "./proof";
import { ReportForm } from "./report-form";

// Публічна сторінка картки: єдине, що видно без входу. Бал, роль, рівень, ім'я
// для показу і розклад балу на звороті; ні гаманців, ні посилань, ні того, чий це акаунт.
// Під ними Proof: факти без імен; з особистим ключем ?k= (профіль-доказ) ще посилання, слова й контакт.

type Props = { params: Promise<{ slug: string }>; searchParams?: Promise<{ k?: string | string[]; as?: string | string[] }> };

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
    // Ключ ?k= не має піти далі разом з переходом на GitHub чи X.
    referrer: "no-referrer",
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

export default async function CardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const k = query?.k;
  // ?as=public: власник дивиться на свою картку очима стороннього (власник 16.09, p1).
  const asPublic = query?.as === "public";
  const view = await loadCardView(slug);
  if (!view) {
    // Раунд 5, п.7: стара адреса прибраної картки (консолідація на одну картку на людину) веде
    // на ту, що лишилась, замість 404.
    const to = await getCardRedirect(db(), slug);
    if (to) redirect(cardPath(to));
    notFound();
  }
  // Власник бачить «Share on X» і картинки; хто він, у HTML не потрапляє.
  const [isOwner, profile] = await Promise.all([loadIsOwner(slug), loadProfileView(slug, !asPublic && typeof k === "string" ? k : null)]);
  const owner = isOwner && !asPublic;
  const origin = await requestOrigin();
  // Клік іде через /go/share-x, який рахує funnel_days ('share_click', /admin/funnel) і
  // веде далі на x.com з тими самими параметрами (без відкритого редіректу: хост фіксований).
  const shareUrl = owner ? `/go/share-x${new URL(xShareUrl(view, origin)).search}` : null;
  const cardUrl = new URL(cardPath(slug), origin).toString();
  const meta = `Formula ${view.formulaVersion}, issued ${view.issuedOn}.`;
  const recipe = isScoredRoleKey(view.role)
    ? `How ${view.roleName} is scored: ${recipeCore(view.role)}. Also: ${recipeBonus(view.role)}.`
    : null;

  return (
    <section className="mx-auto grid max-w-[1280px] items-start gap-12 px-[clamp(16px,4vw,32px)] pt-6 pb-24 sm:pt-10 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-16">
      <div className="grid gap-6">
        <div className="rounded-[32px] border border-line bg-soft p-6 sm:p-10">
          <div className="ncj-card mx-auto max-w-[380px] -rotate-3">
            <CardFront face={view} draw spin />
          </div>
        </div>
        {/* Розклад показуємо, коли він є. Власнику без розкладу панель давала лише текст, і 17.09 її прибрано. */}
        {view.back || !owner ? (
          <CardBackFace face={view} back={view.back} meta={meta} missing={view.backMissing} recipe={recipe} />
        ) : null}
      </div>

      <div className="grid max-w-[60ch] gap-6 lg:pt-4">
        {isOwner && asPublic ? (
          <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-soft px-4 py-3 text-sm text-ink">
            <span>
              <b className="font-semibold">This is what others see.</b> No names, links or contacts, only the facts.
            </span>
            <Link href="/profile#proof" className="font-semibold underline decoration-line-strong underline-offset-4 hover:decoration-ink">
              Back to your profile
            </Link>
          </p>
        ) : null}
        <div className="grid gap-4">
          <h1 className="display text-title">
            {view.roleName}, rated {view.score}
          </h1>
          <p className="text-lg text-ink">
            {view.displayName}. Level {view.level} of 10, {view.tier.finishName.toLowerCase()} finish:{" "}
            {/^[aeiou]/i.test(view.roleName) ? "an" : "a"} {view.roleName} score from {view.levelRange}.
          </p>
          {/* Власник 17.09: на своїй картці один рядок і кнопка, без пояснень продукту. */}
          {owner ? (
            <p className="text-ink-muted">
              This is your score, built from your own onchain and social activity. Share it on X.
            </p>
          ) : (
            <>
              <p className="text-ink-muted">
                NextCryptoJob turns a public track record on X, GitHub and wallets into a score for a crypto role. Under
                the card you see every source, its weight and the points it added.
              </p>
              <p className="text-sm text-ink-muted">
                Issued on {view.issuedOn}, formula {view.formulaVersion}.
              </p>
              {/* Обіцянка в SECURITY.md і в юридичних текстах: цей рядок стоїть на кожній картці, яку бачать інші. */}
              {view.selfReported ? (
                <p className="text-xs text-ink-muted" data-self-reported>
                  Self-reported: the card owner added their X, GitHub and wallets themselves. We score public activity, we
                  do not check who owns an account.
                </p>
              ) : null}
            </>
          )}
        </div>
        {shareUrl ? (
          <div className="grid gap-4 border-t border-line pt-6">
            <div className="flex flex-wrap items-center gap-3">
              {/* Квадрат основний: у стрічці X він займає найбільше місця (напрям D, 16.09). */}
              <ShareOnX text={shareText(view)} cardUrl={cardUrl} imageUrl={`${cardPath(slug)}/share/square`} trackHref={shareUrl} />
              {/* Одна кнопка, без розміру в назві (власник 16.09, п.4): квадрат, той самий файл,
                  що йде в X. /share/wide і /share/tall і далі працюють за прямим посиланням. */}
              <Button asChild size="lg" variant="outline">
                <a href={`${cardPath(slug)}/share/square`} download>
                  Download image
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
        {profile ? <Proof view={profile} /> : null}
      </div>
    </section>
  );
}

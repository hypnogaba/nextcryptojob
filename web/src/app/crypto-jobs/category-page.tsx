import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  categoryBrief,
  categoryDescription,
  categoryHeading,
  CATEGORY_ROLES,
  indexable,
  type CategoryIndex,
  type CategoryRole,
} from "@/lib/jobs/categories";
import { jsonLdScript } from "@/lib/jobs/job-posting";
import { DEFAULT_SITE_URL } from "@/lib/site";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
const NUM = new Intl.NumberFormat("en-US");
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const pathOf = (c: CategoryRole, remote: boolean) => `/crypto-jobs/${c.slug}${remote ? "/remote" : ""}`;

/** Метадані сторінки категорії. Менше CATEGORY_MIN_JOBS вакансій (або бази нема): noindex, follow. */
export function categoryMetadata(c: CategoryRole, remote: boolean, index: CategoryIndex | null): Metadata {
  const slice = index?.roles[c.role][remote ? "remote" : "all"] ?? null;
  const heading = categoryHeading(c, remote);
  return {
    title: heading,
    description: categoryDescription(c, remote, slice?.count ?? 0),
    alternates: { canonical: pathOf(c, remote) },
    ...(slice && indexable(slice) ? {} : { robots: { index: false, follow: true } }),
  };
}

/** Сторінка категорії: H1, три речення, число, до 20 вакансій, кнопка, JSON-LD. */
export function CategoryPage({ c, remote, index }: { c: CategoryRole; remote: boolean; index: CategoryIndex | null }) {
  const slice = index?.roles[c.role][remote ? "remote" : "all"] ?? null;
  const heading = categoryHeading(c, remote);
  const path = pathOf(c, remote);
  const other = pathOf(c, !remote);
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: DEFAULT_SITE_URL + "/" },
          { "@type": "ListItem", position: 2, name: "Crypto jobs", item: `${DEFAULT_SITE_URL}/crypto-jobs` },
          ...(remote
            ? [
                { "@type": "ListItem", position: 3, name: categoryHeading(c, false), item: `${DEFAULT_SITE_URL}${pathOf(c, false)}` },
                { "@type": "ListItem", position: 4, name: heading, item: `${DEFAULT_SITE_URL}${path}` },
              ]
            : [{ "@type": "ListItem", position: 3, name: heading, item: `${DEFAULT_SITE_URL}${path}` }]),
        ],
      },
      {
        "@type": "ItemList",
        name: heading,
        numberOfItems: slice?.jobs.length ?? 0,
        itemListElement: (slice?.jobs ?? []).map((j, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: `${j.title} at ${j.company}`,
          url: `${DEFAULT_SITE_URL}${j.href}`,
        })),
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <section className={`${WRAP} pt-10 pb-20 sm:pt-14`}>
        <nav aria-label="Breadcrumb" className="text-sm text-ink-muted">
          <Link href="/crypto-jobs" className={LINK}>
            Crypto jobs
          </Link>
          {remote ? (
            <>
              {" / "}
              <Link href={pathOf(c, false)} className={LINK}>
                {categoryHeading(c, false)}
              </Link>
            </>
          ) : null}
        </nav>
        <h1 className="display mt-4 max-w-[20ch] text-title">{heading}</h1>
        <div className="mt-5 grid max-w-[62ch] gap-3 text-lg text-ink-muted">
          <p>{c.about}</p>
          <p>We read employer career pages and crypto job boards every day, and drop jobs that are closed or old.</p>
          <p>
            We do not ask for a CV. We match you to {c.noun} jobs by your public X, GitHub and wallets, and send the
            best fits.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button asChild size="lg">
            <Link href={`/start?brief=${encodeURIComponent(categoryBrief(c, remote))}`}>Get these jobs daily</Link>
          </Button>
          <Link href={other} className={`inline-flex min-h-11 items-center ${LINK}`}>
            {remote ? "See all locations" : "Only remote"}
          </Link>
        </div>

        <h2 className="mt-14 font-display text-[1.75rem] leading-tight font-semibold tracking-[-0.02em]">
          {slice ? `${NUM.format(slice.count)} live ${remote ? "remote " : ""}${c.noun} jobs` : "Jobs are not available right now"}
        </h2>
        {slice && slice.jobs.length > 0 ? (
          <>
            <p className="mt-1 text-sm text-ink-muted">Newest {slice.jobs.length} shown, at most two per company.</p>
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {slice.jobs.map((j) => (
                <li key={j.href} className="py-3">
                  <Link href={j.href} className="grid gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <span className="font-semibold text-ink">{j.title}</span>
                    <span className="text-sm text-ink-muted sm:text-right">{j.atMs ? DATE.format(new Date(j.atMs)) : ""}</span>
                    <span className="text-ink-muted">
                      {j.company}
                      {j.place ? `, ${j.place}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-2 text-ink-muted">There are no live jobs in this list at the moment. Check again tomorrow.</p>
        )}

        <h2 className="mt-14 font-display text-xl font-semibold">Other roles</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {CATEGORY_ROLES.filter((r) => r.role !== c.role).map((r) => (
            <li key={r.slug}>
              <Link
                href={pathOf(r, remote)}
                className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink hover:bg-soft"
              >
                {r.noun.charAt(0).toUpperCase() + r.noun.slice(1)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

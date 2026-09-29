import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CATEGORY_ROLES, indexable } from "@/lib/jobs/categories";
import { jsonLdScript } from "@/lib/jobs/job-posting";
import { DEFAULT_SITE_URL } from "@/lib/site";
import { loadCategoryIndex } from "./data";

export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
const NUM = new Intl.NumberFormat("en-US");

export async function generateMetadata(): Promise<Metadata> {
  const index = await loadCategoryIndex();
  return {
    title: "Crypto jobs by role, updated daily",
    description:
      "Live crypto and web3 jobs sorted by role: engineer, security, DevRel, product, marketing and more. Get the best matches by Telegram or email. Free.",
    alternates: { canonical: "/crypto-jobs" },
    ...(index && index.total > 0 ? {} : { robots: { index: false, follow: true } }),
  };
}

/** Хаб категорій: усі ролі з числом живих вакансій і посиланнями на «all» та «remote». */
export default async function CryptoJobsHubPage() {
  const index = await loadCategoryIndex();
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: DEFAULT_SITE_URL + "/" },
          { "@type": "ListItem", position: 2, name: "Crypto jobs", item: `${DEFAULT_SITE_URL}/crypto-jobs` },
        ],
      },
      {
        "@type": "ItemList",
        name: "Crypto jobs by role",
        numberOfItems: CATEGORY_ROLES.length,
        itemListElement: CATEGORY_ROLES.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: `Crypto ${c.noun} jobs`,
          url: `${DEFAULT_SITE_URL}/crypto-jobs/${c.slug}`,
        })),
      },
    ],
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <section className={`${WRAP} pt-10 pb-20 sm:pt-14`}>
        <h1 className="display max-w-[20ch] text-title">Crypto jobs by role</h1>
        <div className="mt-5 grid max-w-[62ch] gap-3 text-lg text-ink-muted">
          <p>
            {index ? `${NUM.format(index.total)} live crypto and web3 jobs, ` : "Live crypto and web3 jobs, "}
            sorted by role. We read employer career pages and crypto job boards every day.
          </p>
          <p>
            Pick a role to see the newest jobs. Or tell us what you want once, and we send you up to 5 matching jobs a
            day by Telegram or email. It is free for candidates.
          </p>
        </div>
        <div className="mt-8">
          <Button asChild size="lg">
            <Link href="/start">Get jobs daily</Link>
          </Button>
        </div>

        <ul className="mt-12 grid overflow-hidden rounded-[10px] border-[1.5px] border-line sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORY_ROLES.map((c) => {
            const data = index?.roles[c.role];
            return (
              <li key={c.slug} className="grid content-start gap-1 border-t border-line p-5 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 lg:[&:nth-child(-n+3)]:border-t-0">
                <h2 className="font-display text-lg font-semibold">
                  <Link href={`/crypto-jobs/${c.slug}`} className="hover:underline">
                    Crypto {c.noun} jobs
                  </Link>
                </h2>
                <p className="text-sm text-ink-muted">
                  {data ? `${NUM.format(data.all.count)} live` : "Live jobs"}
                  {data && indexable(data.remote) ? (
                    <>
                      {", "}
                      <Link href={`/crypto-jobs/${c.slug}/remote`} className={LINK}>
                        {NUM.format(data.remote.count)} remote
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

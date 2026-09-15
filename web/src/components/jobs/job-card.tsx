import { ArrowUpRight, Check } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { logoPath } from "@/lib/jobs/companies";
import { applyLink, EXTERNAL_JOB_REL, externalJobLink } from "@/lib/jobs/link";
import { companySiteUrl, type TokenChip } from "@/lib/jobs/token";
import { CompanyLogo } from "./company-logo";
import { SaveButton } from "./save-button";

/**
 * Картка вакансії на /jobs: значок і назва компанії, місце й зарплата, «чому підходить», про компанію,
 * і "Apply" одразу. Одна картка і для «зараз», і для надісланого раніше.
 *
 * Посилання не збирає сама: rel і адресу вирішує lib/jobs/link.ts (web3.career: apply_url як є, follow,
 * з реферером, і web3.career названо джерелом).
 */

export type CardJob = {
  title: string;
  company: string;
  location: string | null;
  /** Вилка роботодавця («$120k to $150k»). */
  salary: string | null;
  /** Оцінка дошки («est. … (web3.career estimate)»), лише без вилки: приглушено, не зарплата. */
  salaryEstimate?: string | null;
  /** Адреса вакансії: http(s), mailto або сторінка вакансії компанії на сайті `/jobs/<id>`; null, якщо крива. */
  url: string | null;
  /** «Posted by {Company} on NextCryptoJob» для вакансій компаній. */
  postedBy: string | null;
  about?: string | null;
  domain?: string | null;
  /** Чип токена компанії (символ, ціна, MC, зміна за добу); null, якщо токена немає чи ціна не свіжа. */
  token?: TokenChip | null;
};

// Текст із чужих дощок буває одним довгим словом: переносимо будь-де, щоб 390 px не роз'їхались.
const WRAP = "min-w-0 wrap-anywhere";
const TITLE_LINK = "underline decoration-transparent decoration-2 underline-offset-4 transition-colors hover:decoration-line-strong focus-visible:decoration-line-strong";

/** /jobs/<id> з job_ref («nr:<id>» чи «co:<id>»): той самий шлях для обох джерел (раунд 5, п.20). */
export function jobDetailHref(jobRef: string): string {
  return `/jobs/${jobRef.replace(/^(nr|co):/, "")}`;
}

/**
 * Заголовок: коли є `detailHref` (раунд 5, п.20), веде на внутрішню сторінку /jobs/<id> для
 * БУДЬ-ЯКОЇ вакансії (опис, компанія, сайт, токен, причини), не назовні: "Apply" на ній самій веде
 * до компанії. Без detailHref (сторінки поза /jobs, ще без картки-як-посилання) лишається старий
 * шлях: сторінка компанії на сайті "/jobs/<id>" чи зовнішня дошка одразу.
 */
function Title({ job, detailHref }: { job: CardJob; detailHref: string | null }) {
  if (detailHref) {
    return (
      <Link href={detailHref} prefetch={false} className={TITLE_LINK}>
        {job.title}
      </Link>
    );
  }
  const url = job.url;
  if (!url) return <>{job.title}</>;
  // Вакансія компанії: її сторінка на сайті, у тій самій вкладці.
  if (url.startsWith("/")) {
    return (
      <Link href={url} prefetch={false} className={TITLE_LINK}>
        {job.title}
      </Link>
    );
  }
  const link = externalJobLink(url);
  if (!link) return <>{job.title}</>;
  if (link.href.startsWith("mailto:")) {
    return (
      <a href={link.href} className={TITLE_LINK}>
        {job.title}
      </a>
    );
  }
  return (
    <a href={link.href} target="_blank" rel={link.rel} className={TITLE_LINK}>
      {job.title}
    </a>
  );
}

/** Вилка звичайним текстом, як у макеті round4; оцінка дошки приглушено й пунктиром, бо це не зарплата. */
function Pay({ job }: { job: CardJob }) {
  if (job.salary) {
    return (
      <span className="block text-right font-display text-lg leading-tight font-semibold whitespace-nowrap text-ink tabular-nums">
        {job.salary}
      </span>
    );
  }
  if (job.salaryEstimate) {
    return (
      <span className={`rounded-full border border-dashed border-line-strong px-3 py-1 text-[0.8125rem] text-ink-muted ${WRAP}`}>
        {job.salaryEstimate}
      </span>
    );
  }
  return <span className="rounded-full bg-soft px-3 py-1.5 text-sm font-medium whitespace-nowrap text-ink-muted">Salary not listed</span>;
}

/** Домен приглушеним текстом; посилання на сайт компанії, якщо домен придатний. Спільна для картки й /jobs/<id>. */
export function CompanySite({ domain }: { domain: string }) {
  const url = companySiteUrl(domain);
  if (!url) return <span>{domain}</span>;
  return (
    <a href={url} target="_blank" rel={EXTERNAL_JOB_REL} className="underline decoration-line-strong underline-offset-2 hover:decoration-ink">
      {domain}
    </a>
  );
}

/**
 * Чип токена компанії: символ, ціна, MC і зміна за добу (червона лише коли вниз, як єдиний тривожний
 * колір сайту). flex-wrap і tabular-nums без white-space:nowrap: довгий тікер переходить на новий
 * рядок усередині чипа, а не роз'їжджає картку на 390 px. Спільна для картки й /jobs/<id>.
 */
export function TokenBadge({ token }: { token: TokenChip }) {
  const down = token.change?.startsWith("-") ?? false;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-2xl bg-soft px-3 py-1 text-[0.8125rem] font-medium tabular-nums text-ink-muted">
      <span className="font-semibold text-ink">{token.symbol}</span>
      <span>{token.price}</span>
      {token.mcap ? <span>{token.mcap}</span> : null}
      {token.change ? <span className={down ? "text-danger" : "text-ink"}>{token.change}</span> : null}
    </span>
  );
}

function Why({ reasons, why, note, label }: { reasons?: readonly string[]; why?: string | null; note?: string | null; label: string }) {
  const list = reasons?.length ? reasons : null;
  if (!list && !why) return null;
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[0.8125rem] font-bold text-ink">{label}</p>
      {list ? (
        <ul className="grid gap-2">
          {list.map((r) => (
            <li key={r} className={`grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[0.9375rem] leading-[22px] text-ink ${WRAP}`}>
              <span aria-hidden="true" className="mt-px grid size-5 place-items-center rounded-full bg-soft">
                <Check className="size-3 text-ink" strokeWidth={3.5} />
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`text-[0.9375rem] leading-[22px] text-ink ${WRAP}`}>{why}</p>
      )}
      {note ? <p className={`mt-2 text-sm text-ink-muted ${WRAP}`}>{note}</p> : null}
    </div>
  );
}

function Apply({ job, compact, jobRef, saved }: { job: CardJob; compact: boolean; jobRef?: string; saved?: boolean }) {
  const apply = applyLink(job.url);
  const note = job.postedBy ? `Posted by ${job.postedBy} on NextCryptoJob` : apply?.via ? `via ${apply.via}` : null;
  const save = jobRef ? <SaveButton jobRef={jobRef} initialSaved={Boolean(saved)} compact={compact} /> : null;
  if (!apply) {
    if (!note && !save) return null;
    return (
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {note ? <p className={`text-xs text-ink-muted ${WRAP}`}>{note}</p> : null}
        {save}
      </div>
    );
  }
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button asChild size={compact ? "default" : "lg"} variant={compact ? "outline" : "default"} className="w-full sm:w-auto">
        <a href={apply.href} {...(apply.newTab ? { target: "_blank", rel: apply.rel ?? undefined } : {})}>
          {apply.label}
          {apply.newTab ? <ArrowUpRight aria-hidden="true" data-icon="inline-end" /> : null}
          {apply.newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </a>
      </Button>
      {save}
      {note ? <p className={`text-xs text-ink-muted ${WRAP}`}>{note}</p> : null}
    </div>
  );
}

export function JobCard({
  job,
  reasons,
  why,
  note,
  rank,
  compact = false,
  jobRef,
  saved,
}: {
  job: CardJob;
  /** Причини списком (вибір «зараз»). */
  reasons?: readonly string[];
  /** Причини одним рядком (sent.why надісланого раніше). */
  why?: string | null;
  /** «Still open, posted 6 weeks ago.» поруч із причинами. */
  note?: string | null;
  /** Місце у виборі: 1..5. */
  rank?: number;
  /** Надіслане раніше: тихіша кнопка. */
  compact?: boolean;
  /** job_ref (sent.job_ref, "nr:<id>"/"co:<id>"): показує «Save» (раунд 5, п.16). Без нього кнопки нема. */
  jobRef?: string;
  /** Чи вже збережена (Saved на /jobs). */
  saved?: boolean;
}) {
  const domain = job.domain ?? null;
  const hasWhy = Boolean(reasons?.length || why);
  // Раунд 5, п.20: уся картка клікабельна на внутрішню /jobs/<id>, коли є jobRef. "Розтягнуте
  // посилання" (overlay нижче, вміст поверх): Title, Apply і Save лишаються своїми посиланнями.
  const detailHref = jobRef ? jobDetailHref(jobRef) : null;
  return (
    <li className="relative rounded-3xl border-[1.5px] border-line bg-surface p-5 transition-[border-color,box-shadow] duration-300 hover:border-[#d5d7dd] hover:shadow-[0_18px_36px_-24px_rgb(17_19_24/30%)] sm:p-7">
      {detailHref ? (
        <Link href={detailHref} prefetch={false} aria-hidden="true" tabIndex={-1} className="absolute inset-0 z-0 rounded-3xl" />
      ) : null}
      <div className="relative z-[1]">
        <div className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 sm:grid-cols-[56px_minmax(0,1fr)_auto]">
          <CompanyLogo name={job.company} src={logoPath(domain)} size={compact ? 44 : 56} />
          <div className="min-w-0">
            <h3 className={`font-display text-xl leading-7 font-semibold tracking-[-0.015em] text-ink sm:text-2xl sm:leading-[30px] ${WRAP}`}>
              {rank ? <span className="sr-only">Match {rank}: </span> : null}
              <Title job={job} detailHref={detailHref} />
            </h3>
            <p className={`mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.9375rem] text-ink-muted ${WRAP}`}>
              <span className="font-semibold text-ink">{job.company}</span>
              {domain ? <CompanySite domain={domain} /> : null}
              {job.location ? <span>{job.location}</span> : null}
            </p>
            {job.token ? (
              <div className="mt-2">
                <TokenBadge token={job.token} />
              </div>
            ) : null}
          </div>
          <div className="col-span-full justify-self-start sm:col-span-1 sm:justify-self-end">
            <Pay job={job} />
          </div>
        </div>
        {hasWhy || job.about ? (
          <div className={`mt-5 grid gap-6 border-t border-line pt-5 ${hasWhy && job.about ? "md:grid-cols-2" : ""}`}>
            <Why reasons={reasons} why={why} note={note} label={compact ? "Why we sent it" : "Why this fits you"} />
            {job.about ? (
              <div className="min-w-0">
                <p className="mb-2 text-[0.8125rem] font-bold text-ink">About the company</p>
                <p className={`text-[0.9375rem] leading-[22px] text-ink-muted ${WRAP}`}>{job.about}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        <Apply job={job} compact={compact} jobRef={jobRef} saved={saved} />
      </div>
    </li>
  );
}

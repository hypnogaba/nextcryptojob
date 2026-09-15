import Link from "next/link";
import { Suspense } from "react";
import { myDemoCompanyId } from "@/lib/admin/demo";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { cn } from "@/lib/utils";
import { openDemoAction } from "@/app/admin/actions";

/**
 * Усі сторінки адмінки, плоским списком (як до п.18): джерело правди для адрес і назв. Нова
 * сторінка додається сюди й у свою групу нижче (ADMIN_GROUPS), і посилання з'являється на всіх
 * сторінках адмінки.
 */
export const ADMIN_PAGES = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/candidates", label: "Candidates" },
  { href: "/admin/scores", label: "Scores" },
  { href: "/admin/funnel", label: "Funnel" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/agency-applications", label: "Agencies" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/jobs", label: "Company jobs" },
  { href: "/admin/sources", label: "Job sources" },
  { href: "/admin/x-queue", label: "X queue" },
  { href: "/admin/messages", label: "Messages" },
  { href: "/admin/testimonials", label: "Testimonials" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number]["href"];

const PAGE_BY_HREF = new Map<AdminPage, string>(ADMIN_PAGES.map((p) => [p.href, p.label]));

/**
 * Групи меню (п.18, 15.09: забагато пунктів меню): Overview; People (кандидати, бали, лійка);
 * Companies (компанії, агенції, платежі); Jobs (вакансії компаній, джерела, черга X); Inbox
 * (повідомлення, відгуки); Settings. Жодна стара сторінка не загублена: усі 12 адрес, що були в
 * плоскому списку до цієї правки, тут є, плюс нова /admin/candidates.
 */
const ADMIN_GROUPS: { label: string | null; hrefs: readonly AdminPage[] }[] = [
  { label: null, hrefs: ["/admin"] },
  { label: "People", hrefs: ["/admin/candidates", "/admin/scores", "/admin/funnel"] },
  { label: "Companies", hrefs: ["/admin/companies", "/admin/agency-applications", "/admin/payments"] },
  { label: "Jobs", hrefs: ["/admin/jobs", "/admin/sources", "/admin/x-queue"] },
  { label: "Inbox", hrefs: ["/admin/messages", "/admin/testimonials"] },
  { label: null, hrefs: ["/admin/settings"] },
];

const TAB =
  "inline-flex min-h-11 items-center border-b-2 font-semibold whitespace-nowrap transition-colors border-transparent text-ink-muted hover:border-line-strong hover:text-ink";
const TAB_CURRENT = "inline-flex min-h-11 items-center border-b-2 font-semibold whitespace-nowrap border-ink text-ink";

/**
 * «View as company» (п.19): та сама дія, що кнопка «Open demo» в блоці Demo company на /admin,
 * лише коли в цього адміна вже є демо-компанія. Окремий async-компонент у Suspense, не весь
 * AdminNav: сторінки адмінки рендерять AdminNav синхронно (page.test.tsx кличе сторінку й одразу
 * renderToStaticMarkup, без черги React на асинхронні компоненти), а цей маленький шматок нехай
 * почекає своїх даних під fallback={null}, не валячи решту меню.
 */
async function ViewAsCompanyLink() {
  const admin = await currentAdmin();
  const demoCompanyId = admin ? await myDemoCompanyId(db(), admin.id) : null;
  return demoCompanyId ? <ViewAsCompanyButton companyId={demoCompanyId} /> : null;
}

function ViewAsCompanyButton({ companyId }: { companyId: string }) {
  return (
    <form action={openDemoAction} className="flex">
      <input type="hidden" name="company_id" value={companyId} />
      <button type="submit" className={TAB}>
        View as company
      </button>
    </form>
  );
}

/**
 * Перемикач сторінок адмінки: над заголовком на самих сторінках і в кабінеті. Рядок груп, кожна
 * зі своєю приглушеною міткою; поточна сторінка з рискою 2 px кольору тексту.
 *
 * `viewAsCompanyId`: сторінка, що вже знає id демо-компанії (наприклад /admin через demoState для
 * свого блоку Demo company), передає його напряму (чи null, якщо демо нема) і не платить за ще один
 * запит. Решта сторінок лишає проп не заданим: ViewAsCompanyLink знайде його сам під Suspense,
 * щоб не ламати сторінки, які рендерять AdminNav синхронно (page.test.tsx кличе сторінку й одразу
 * renderToStaticMarkup, без черги React на асинхронні компоненти); там посилання просто не встигає
 * з'явитись, а решта меню лишається як є.
 *
 * Показувати AdminNav лише тому, хто пройшов currentAdmin() чи isAdminSession().
 */
export function AdminNav({
  current,
  className = "mb-6",
  viewAsCompanyId,
}: {
  current?: AdminPage;
  className?: string;
  viewAsCompanyId?: string | null;
}) {
  return (
    <nav aria-label="Admin" className={cn("flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-line text-sm", className)}>
      <span className="font-display text-base font-extrabold tracking-[0.04em] text-ink-muted uppercase">Admin</span>
      {ADMIN_GROUPS.map((g, i) => (
        <div key={g.label ?? `g${i}`} className="flex flex-wrap items-center gap-x-3">
          {g.label ? <span className="text-xs font-bold tracking-[0.06em] text-ink-muted/70 uppercase">{g.label}</span> : null}
          {g.hrefs.map((href) => (
            <Link key={href} href={href} aria-current={href === current ? "page" : undefined} className={href === current ? TAB_CURRENT : TAB}>
              {PAGE_BY_HREF.get(href)}
            </Link>
          ))}
        </div>
      ))}
      {viewAsCompanyId !== undefined ? (
        viewAsCompanyId ? <ViewAsCompanyButton companyId={viewAsCompanyId} /> : null
      ) : (
        <Suspense fallback={null}>
          <ViewAsCompanyLink />
        </Suspense>
      )}
    </nav>
  );
}

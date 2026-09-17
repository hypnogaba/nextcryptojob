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
  { href: "/admin/sources", label: "Job sources" },
  { href: "/admin/demand", label: "Jobs and demand" },
  { href: "/admin/messages", label: "Messages" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/agency-applications", label: "Agencies" },
  { href: "/admin/jobs", label: "Company jobs" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/funnel", label: "Funnel" },
  { href: "/admin/x-queue", label: "X queue" },
  { href: "/admin/testimonials", label: "Testimonials" },
  { href: "/admin/health", label: "Health" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number]["href"];

const PAGE_BY_HREF = new Map<AdminPage, string>(ADMIN_PAGES.map((p) => [p.href, p.label]));

/**
 * Меню (власник 16.09: пункти не вміщаються; 17.09: «зроби щоб вони були десь в пунктах меню,
 * тіпа агенції, запити компаній»). Одним рядком те, чим користуються щодня; решта у двох
 * списках за темою: «Companies» (усе про компанії, заявки й оплати) і «More».
 *
 * Жодна сторінка не загублена: ADMIN_MAIN і групи разом дають ADMIN_PAGES (admin-nav.test.tsx).
 */
export const ADMIN_MAIN: readonly AdminPage[] = ["/admin", "/admin/candidates", "/admin/sources", "/admin/messages"];

/** Після списків, у кінці рядка. */
export const ADMIN_TAIL: readonly AdminPage[] = ["/admin/settings"];

export type AdminGroup = { label: string; pages: readonly AdminPage[] };

export const ADMIN_GROUPS: readonly AdminGroup[] = [
  { label: "Companies", pages: ["/admin/companies", "/admin/agency-applications", "/admin/jobs", "/admin/payments"] },
  { label: "More", pages: ["/admin/scores", "/admin/demand", "/admin/funnel", "/admin/x-queue", "/admin/testimonials", "/admin/health"] },
];

/** Усе, що не в головному рядку (для тестів і для перевірки, що нічого не загубилось). */
export const ADMIN_MORE: readonly AdminPage[] = ADMIN_GROUPS.flatMap((g) => [...g.pages]);

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

/** Один список меню: «Companies» чи «More». Відкрита сторінка всередині названа на кнопці. */
function Dropdown({ group, current }: { group: AdminGroup; current?: AdminPage }) {
  const inside = current !== undefined && group.pages.includes(current);
  return (
    <details className="group relative" data-admin-group={group.label}>
      <summary className={cn(inside ? TAB_CURRENT : TAB, "cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden")}>
        {inside ? `${group.label}: ${PAGE_BY_HREF.get(current!)}` : group.label}
        <span aria-hidden className="inline-block transition-transform group-open:rotate-180">
          {"\u25BE"}
        </span>
      </summary>
      <ul className="absolute left-0 top-full z-30 mt-1 grid min-w-52 gap-0.5 rounded-[10px] border-[1.5px] border-line bg-surface p-2 shadow-[0_18px_36px_-24px_rgb(17_19_24/30%)]">
        {group.pages.map((href) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={href === current ? "page" : undefined}
              className={cn(
                "flex min-h-10 items-center rounded-md px-3 font-semibold whitespace-nowrap hover:bg-soft",
                href === current ? "text-ink" : "text-ink-muted hover:text-ink",
              )}
            >
              {PAGE_BY_HREF.get(href)}
            </Link>
          </li>
        ))}
      </ul>
    </details>
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
    <nav aria-label="Admin" className={cn("relative z-20 flex flex-wrap items-end gap-x-4 gap-y-1 border-b border-line text-sm", className)}>
      {/* Мітка тієї ж висоти й з тією ж прозорою рискою, що вкладки: усе стоїть одним рядком по центру. */}
      <span className="inline-flex min-h-11 items-center border-b-2 border-transparent font-display text-base font-extrabold tracking-[0.04em] text-ink-muted uppercase">
        Admin
      </span>
      {ADMIN_MAIN.map((href) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined} className={href === current ? TAB_CURRENT : TAB}>
          {PAGE_BY_HREF.get(href)}
        </Link>
      ))}
      {ADMIN_GROUPS.map((group) => (
        <Dropdown key={group.label} group={group} current={current} />
      ))}
      {ADMIN_TAIL.map((href) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined} className={href === current ? TAB_CURRENT : TAB}>
          {PAGE_BY_HREF.get(href)}
        </Link>
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

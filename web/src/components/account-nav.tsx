import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Кабінет, round4 (макет design-round4/dir-6): бічне меню зі спільним активним станом (чорна
 * смужка зліва на десктопі, підсвітка тла при наведенні) і вміст праворуч. На мобільному
 * бічне меню стає горизонтальним рядком, що гортається (globals.css, .acct-side).
 * Той самий компонент для /account і /settings: активний пункт визначає сторінка.
 */
export type AccountKey = "overview" | "card" | "jobs" | "saved" | "answers" | "settings";

/**
 * Без "Company account" (власник 16.09, п.1): створення компанії лишається на /company, зі
 * своїми кнопками; кабінет кандидата про це не питає. Маршрут /company/start і далі працює для
 * тих, хто прийшов з /company.
 *
 * Порядок (власник 17.09): «Your jobs» ПЕРШИМ пунктом, вище за все інше. Людина приходить по
 * вакансії, а не по картку. «Saved» це підпункт вакансій: збережені більше не тягнуться довгим
 * хвостом на /jobs, вони мають власну сторінку.
 */
const ITEMS: readonly { key: AccountKey; href: string; label: string; sub?: boolean }[] = [
  { key: "jobs", href: "/jobs", label: "Your jobs" },
  { key: "saved", href: "/jobs/saved", label: "Saved jobs", sub: true },
  { key: "overview", href: "/account", label: "Overview" },
  { key: "card", href: "/profile", label: "Card and score" },
  { key: "answers", href: "/welcome", label: "Your answers" },
  { key: "settings", href: "/settings", label: "Settings" },
];

/**
 * `title` необов'язковий (раунд 5, п.10): деякі сторінки (наприклад /welcome в режимі правки)
 * мають власний заголовок усередині `children` і не потребують ще одного h1 тут.
 *
 * Одна ширина контейнера для всіх сторінок кабінету (власник 16.09, п.3): раніше /jobs брала
 * max-w-[1360px], а решта max-w-5xl, тож і бічне меню, і вміст стрибали ліворуч-праворуч між
 * сторінками кабінету. /jobs і далі має місце для двоколонкового вмісту в тій самій ширині.
 */
const SHELL_WIDTH = "max-w-[1360px]";

/**
 * Одна висота шапки на всіх сторінках кабінету (власник 17.09: «зроби щоб все було однаково, не
 * рухалося вгору-вниз»). Раніше висота шапки залежала від довжини заголовка й наявності
 * підзаголовка, тож бічне меню ставало на різній висоті на кожній сторінці. Тепер заголовок і
 * підзаголовок живуть у блоці незмінної висоти: один рядок заголовка плюс рядок підзаголовка.
 * Той самий блок тримає місце й там, де заголовка немає.
 */
const HEAD_HEIGHT = "min-h-[78px] sm:min-h-[92px] lg:min-h-[104px]";

export function AccountShell({
  active,
  title,
  sub,
  children,
}: {
  active: AccountKey;
  title?: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section className={`mx-auto ${SHELL_WIDTH} px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14`}>
      <div className={`grid content-start ${HEAD_HEIGHT}`}>
        {title ? <h1 className="display text-title text-balance">{title}</h1> : null}
        {sub ? <p className="mt-2 text-ink-muted">{sub}</p> : null}
      </div>
      <div className="acct mt-8">
        <nav aria-label="Your account" className="acct-side">
          {ITEMS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? "page" : undefined}
              className={item.sub ? "acct-item acct-sub" : "acct-item"}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="acct-content">{children}</div>
      </div>
    </section>
  );
}

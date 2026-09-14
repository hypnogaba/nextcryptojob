"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Значок компанії на картці вакансії: літера назви завжди, а поверх неї значок сайту компанії
 * (/api/logo, лише домени з реєстру), щойно він завантажився. Не завантажився чи домену немає:
 * лишається літера. Картинка з нашого походження, тож CSP лишається img-src 'self'.
 */

/** Перша літера чи цифра назви: «0x» → «0», «Ætherlabs» → «Æ». */
export function initialOf(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name);
  return (m?.[0] ?? "?").toUpperCase();
}

export function CompanyLogo({ name, src, size = 48 }: { name: string; src: string | null; size?: number }) {
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Картинка з кешу може завантажитись ще до гідрації, і onLoad тоді не прийде.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth > 0) setLoaded(true);
  }, []);

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-2xl bg-soft font-display text-xl font-bold text-ink shadow-[inset_0_0_0_1px_var(--line)] select-none"
    >
      {initialOf(name)}
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- значок 64 px з нашого /api/logo, оптимізатор тут зайвий
        <img
          ref={img}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={`absolute inset-0 size-full bg-white object-contain p-[18%] transition-opacity duration-150 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
    </span>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Раунд 5, п.3: у вікні X видно лише посилання без картинки (X показує картку тільки після
 * публікації). Робимо так, щоб картинка була в пості одразу:
 * - телефон: Web Share API з файлом PNG картки (navigator.canShare({files})): картинка
 *   прикріплюється в X сама, разом із текстом і посиланням;
 * - комп'ютер: буфер обміну (ClipboardItem) плюс звичайний перехід за посиланням на X;
 * - немає жодного з цих API (старий браузер): звичайне посилання на x.com через /go/share-x,
 *   як і раніше (OG-прев'ю запасним планом). У кожному шляху трек share_click лишається:
 *   `trackHref` (/go/share-x?...) або йде переходом, або опитується у фоні (keepalive), коли
 *   JS сам ділиться файлом.
 *
 * Раунд 6 (власник: «не хоче відкривати ікс разом з цією картинкою»): і буфер, і нове вікно
 * дозволені браузеру лише ПОКИ триває дозвіл від кліку. Перша версія спершу чекала на
 * `fetch` картинки, і до `clipboard.write` та `window.open` дозвіл уже згорав: Safari відмовляв
 * у буфері, Chrome блокував вікно. Тепер:
 * - PNG тягнемо наперед, щойно кнопка з'явилась (і ще раз на pointerdown), тож на кліку
 *   файл уже в руках і `navigator.share` викликається без жодного await перед ним;
 * - на комп'ютері НЕ перехоплюємо клік: X відкривається звичайним переходом за href, а в буфер
 *   пишемо тим самим кліком через `ClipboardItem` з обіцянкою (Safari приймає лише таку форму).
 */
export function ShareOnX({
  text,
  cardUrl,
  imageUrl,
  trackHref,
}: {
  /** «I scored N as a Role on NextCryptoJob. Level L of 10.» */
  text: string;
  /** Публічна адреса картки (https://…/c/<slug>). */
  cardUrl: string;
  /** PNG 16:9 картки (cardPath(slug) + "/share/wide"). */
  imageUrl: string;
  /** /go/share-x?text=…&url=…: рахує share_click і веде на x.com (запасний план). */
  trackHref: string;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** PNG картки, завантажений наперед: на кліку вже має бути тут. */
  const file = useRef<File | null>(null);
  const loading = useRef<Promise<File | null> | null>(null);

  function fetchImage(): Promise<File | null> {
    if (file.current) return Promise.resolve(file.current);
    loading.current ??= fetch(imageUrl)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        file.current = blob ? new File([blob], "nextcryptojob-card.png", { type: blob.type || "image/png" }) : null;
        return file.current;
      })
      .catch(() => null);
    return loading.current;
  }

  useEffect(() => {
    void fetchImage();
    // imageUrl не змінюється за життя сторінки картки; окремий ключ не потрібен.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  function track(): void {
    try {
      void fetch(trackHref, { keepalive: true });
    } catch {
      // Лічильник не критичний: клік усе одно веде людину далі.
    }
  }

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>): void {
    const nav = navigator;
    const ready = file.current;

    // Телефон: ділимось файлом. Виклик share() іде без await перед ним, інакше згорає дозвіл кліку.
    if (ready && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [ready] })) {
      e.preventDefault();
      setBusy(true);
      track();
      nav
        .share({ files: [ready], text, url: cardUrl })
        .catch(() => {
          // Людина скасувала або система відмовила: лишаємо кнопку, наступний клік піде за href.
        })
        .finally(() => setBusy(false));
      return;
    }

    // Комп'ютер: X відкривається звичайним переходом (href), а картинка лягає в буфер цим же кліком.
    if (typeof nav.clipboard?.write === "function" && typeof window.ClipboardItem === "function") {
      try {
        const png = fetchImage().then((f) => f ?? Promise.reject(new Error("no card image")));
        nav.clipboard
          .write([new window.ClipboardItem({ "image/png": png })])
          .then(() => {
            const mac = /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent);
            setHint(`Paste the image (${mac ? "Cmd" : "Ctrl"}+V)`);
          })
          .catch(() => {
            // Буфер відмовив (дозвіл, старий браузер): пост усе одно відкрився, лише без картинки.
          });
      } catch {
        // ClipboardItem не прийняв обіцянку: теж не біда, перехід за href уже триває.
      }
    }
    // Клік не перехоплено: браузер сам відкриває trackHref, який рахує share_click і веде на X.
  }

  return (
    <div className="grid gap-2">
      <Button asChild size="lg">
        <a
          href={trackHref}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={() => void fetchImage()}
          onClick={handleClick}
          aria-busy={busy || undefined}
        >
          Share on X
        </a>
      </Button>
      {hint ? (
        <p role="status" className="text-sm text-ink-muted">
          Image copied. {hint} in the X post.
        </p>
      ) : null}
    </div>
  );
}

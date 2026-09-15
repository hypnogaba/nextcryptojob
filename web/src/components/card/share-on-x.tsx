"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Раунд 5, п.3: у вікні X видно лише посилання без картинки (X показує картку тільки після
 * публікації). Робимо так, щоб картинка була в пості одразу:
 * - телефон: Web Share API з файлом PNG картки (navigator.canShare({files})): картинка
 *   прикріплюється в X сама, разом із текстом і посиланням;
 * - комп'ютер: кнопка копіює картинку в буфер обміну (ClipboardItem), відкриває X із текстом
 *   і показує підказку «Paste the image» з правильною клавішею (Cmd на Mac, інакше Ctrl);
 * - немає жодного з цих API (старий браузер): звичайне посилання на x.com через /go/share-x,
 *   як і раніше (OG-прев'ю запасним планом). У кожному шляху трек share_click лишається:
 *   `trackHref` (/go/share-x?...) або йде переходом, або опитується у фоні (keepalive), коли
 *   JS сам відкриває X чи ділиться файлом.
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

  function track(): void {
    try {
      void fetch(trackHref, { keepalive: true });
    } catch {
      // Лічильник не критичний: клік усе одно веде людину далі.
    }
  }

  async function handleClick(e: React.MouseEvent<HTMLAnchorElement>): Promise<void> {
    const nav = navigator;

    if (typeof nav.share === "function" && typeof nav.canShare === "function") {
      e.preventDefault();
      setBusy(true);
      try {
        const blob = await (await fetch(imageUrl)).blob();
        const file = new File([blob], "nextcryptojob-card.png", { type: blob.type || "image/png" });
        if (nav.canShare({ files: [file] })) {
          track();
          await nav.share({ files: [file], text, url: cardUrl });
          setBusy(false);
          return;
        }
      } catch {
        // Людина скасувала чи файл не вийшов: пробуємо шлях комп'ютера нижче.
      }
    }

    if (typeof nav.clipboard?.write === "function" && typeof window.ClipboardItem === "function") {
      e.preventDefault();
      try {
        const blob = await (await fetch(imageUrl)).blob();
        const type = blob.type || "image/png";
        await nav.clipboard.write([new window.ClipboardItem({ [type]: blob })]);
        track();
        const mac = /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent);
        setHint(`Paste the image (${mac ? "Cmd" : "Ctrl"}+V)`);
        window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(cardUrl)}`, "_blank", "noopener,noreferrer");
        setBusy(false);
        return;
      } catch {
        // Буфер обміну відмовив (дозвіл, старий браузер): звичайне посилання нижче, без картинки.
      }
    }
    setBusy(false);
    // Ні Web Share, ні буфер обміну: звичайний перехід за href (trackHref рахує клік сам).
  }

  return (
    <div className="grid gap-2">
      <Button asChild size="lg">
        <a href={trackHref} target="_blank" rel="noopener noreferrer" onClick={handleClick} aria-busy={busy || undefined}>
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

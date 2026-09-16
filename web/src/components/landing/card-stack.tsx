"use client";

import type { PointerEvent } from "react";
import { useRef } from "react";
import { CardFront } from "@/components/card/card-front";
import type { CardFace } from "@/lib/card/view";

/**
 * ОДНА картка на головній (власник 16.09: «тут можна лише одну вже карту дати, такий круг мені
 * подобався»): стос із чотирьох обробок і перекладання прибрано. Лишилась жива картка напряму D:
 * кругла печатка, що обертається, і бал у чистому крузі.
 *
 * Картка нахиляється за курсором (перспектива, до ~10deg) і має світлову смугу; з'являється
 * знизу один раз при показі (CSS, globals.css .ncj-slot). Під prefers-reduced-motion CSS сама
 * вимикає і появу, і нахил: pointermove тут нічого не зіпсує, він лише не буде видно.
 */
export function CardStack({ faces }: { faces: readonly CardFace[] }) {
  const front = useRef<HTMLDivElement>(null);
  const face = faces[0]!;

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const el = front.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / r.width;
    const y = (e.clientY - (r.top + r.height / 2)) / r.height;
    el.style.setProperty("--tx", (x * 10).toFixed(2));
    el.style.setProperty("--ty", (-y * 8).toFixed(2));
  }

  function onPointerLeave() {
    const el = front.current;
    if (!el) return;
    el.style.setProperty("--tx", "0");
    el.style.setProperty("--ty", "0");
  }

  return (
    <div className="ncj-stage">
      <div className="ncj-stack" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
        <div className="ncj-slot">
          <div ref={front} className="ncj-card ncj-tilt">
            <CardFront face={face} draw spin sweep hideTag />
          </div>
        </div>
      </div>
      <p className="ncj-cap">
        Your card is built from what you have done. It is unique, matches only you, and is made to share on X.
      </p>
    </div>
  );
}

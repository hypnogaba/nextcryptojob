"use client";

import type { CSSProperties, PointerEvent } from "react";
import { useRef } from "react";
import { CardFront } from "@/components/card/card-front";
import { tierFor, tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";

/**
 * Стос карток головної (round4, макет design-round4/dir-6): три статичні заготовки (лише тло
 * і волосяна лінія, без тексту й наведення), трохи зсунуті вгору-вліво, і жива картка спереду.
 * Жива картка нахиляється за курсором (перспектива, до ~10deg) і має світлову смугу; усі чотири
 * розкладаються віялом один раз при показі (CSS, globals.css .ncj-slot). Під
 * prefers-reduced-motion CSS сама вимикає і анімацію, і нахил: pointermove тут нічого не
 * зіпсує, він лише не буде видно.
 */
const BACK_SLOTS = [
  { level: 2, x: "-54px", y: "-42px", rot: "-4deg", d: "0.05s" },
  { level: 4, x: "-36px", y: "-28px", rot: "-2.6deg", d: "0.18s" },
  { level: 6, x: "-18px", y: "-14px", rot: "-1.2deg", d: "0.31s" },
] as const;

export function CardStack({ face }: { face: CardFace }) {
  const front = useRef<HTMLDivElement>(null);

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
        {BACK_SLOTS.map((s) => (
          <div key={s.level} className="ncj-slot" style={{ "--x": s.x, "--y": s.y, "--rot": s.rot, "--d": s.d } as CSSProperties}>
            <div className="ncj-card" style={tierVars(tierFor(s.level)) as CSSProperties}>
              <div className="ncj-face" aria-hidden="true" />
            </div>
          </div>
        ))}
        <div className="ncj-slot" style={{ "--x": "0px", "--y": "0px", "--rot": "0deg", "--d": "0.44s" } as CSSProperties}>
          <div ref={front} className="ncj-card ncj-tilt">
            <CardFront face={face} spin sweep hideTag />
          </div>
        </div>
      </div>
      <p className="ncj-cap">
        Your card is built from what you have done. It is unique, matches only you, and is made to share on X.
      </p>
    </div>
  );
}

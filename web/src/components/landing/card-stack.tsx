"use client";

import type { CSSProperties, PointerEvent } from "react";
import { useRef, useState } from "react";
import { CardFront } from "@/components/card/card-front";
import { tierFor, tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";

/**
 * Стос карток головної (round4, макет design-round4/dir-6): три заготовки, трохи зсунуті
 * вгору-вліво, і жива картка спереду. Жива картка нахиляється за курсором (перспектива, до ~10deg)
 * і має світлову смугу; усі чотири розкладаються віялом один раз при показі (CSS, globals.css
 * .ncj-slot). Під prefers-reduced-motion CSS сама вимикає і анімацію, і нахил.
 *
 * Раунд 6 (власник 16.09: «коли мишкою наводжу на ті, що заді, картки і клацаю, то вони вилазили
 * наперед, і міг би подивитися кілька варіантів»): задні картки це кнопки. Наведення трохи
 * піднімає картку, клік ставить її спереду й показує її обробку повністю, а та, що була спереду,
 * іде на її місце. Стрілки й пробіл працюють, бо це справжні кнопки.
 */
const SLOTS = [
  { x: "0px", y: "0px", rot: "0deg", d: "0.44s" },
  { x: "-18px", y: "-14px", rot: "-1.2deg", d: "0.31s" },
  { x: "-36px", y: "-28px", rot: "-2.6deg", d: "0.18s" },
  { x: "-54px", y: "-42px", rot: "-4deg", d: "0.05s" },
] as const;

/** Затримка руху за місцем у стосі: стос перекладається хвилею, а не разом. */
const WAVE_STEP_MS = 70;

export function CardStack({ faces }: { faces: readonly CardFace[] }) {
  const front = useRef<HTMLDivElement>(null);
  // Порядок карток у стосі: перша спереду. Клік по задній міняє її з передньою місцями.
  const [order, setOrder] = useState<readonly number[]>(() => faces.map((_, i) => i));
  // Картка, яку щойно витягли: грає коротку «здачу» зверху (CSS .ncj-deal).
  const [dealt, setDealt] = useState<number | null>(null);

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

  function bringForward(index: number) {
    setOrder((prev) => [index, ...prev.filter((i) => i !== index)]);
    setDealt(index);
    onPointerLeave();
  }

  const frontIndex = order[0] ?? 0;
  const frontFace = faces[frontIndex]!;

  return (
    <div className="ncj-stage">
      <div className="ncj-stack" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
        {order.map((faceIndex, position) => {
          const slot = SLOTS[Math.min(position, SLOTS.length - 1)]!;
          const face = faces[faceIndex]!;
          const style = {
            "--x": slot.x,
            "--y": slot.y,
            "--rot": slot.rot,
            // Затримка ПОЧАТКОВОГО віяла належить самій картці, не місцю: інакше при перекладанні
            // змінилась би вже відіграна анімація і картка блимнула б.
            "--d": SLOTS[Math.min(faceIndex, SLOTS.length - 1)]!.d,
            // Хвиля: що далі картка в стосі, то пізніше рушає.
            "--wave": `${position * WAVE_STEP_MS}ms`,
            zIndex: order.length - position,
          } as CSSProperties;
          if (position === 0) {
            return (
              <div key={faceIndex} className="ncj-slot" style={style}>
                <div
                  ref={front}
                  className={dealt === faceIndex ? "ncj-card ncj-tilt ncj-deal" : "ncj-card ncj-tilt"}
                  onAnimationEnd={() => setDealt(null)}
                >
                  <CardFront face={face} spin sweep hideTag />
                </div>
              </div>
            );
          }
          return (
            <button
              key={faceIndex}
              type="button"
              className="ncj-slot ncj-slot-back"
              style={style}
              onClick={() => bringForward(faceIndex)}
              aria-label={`Show the ${face.tier.finishName} card, level ${face.level} of 10`}
            >
              <div className="ncj-card" style={tierVars(tierFor(face.level)) as CSSProperties}>
                <div className="ncj-face" aria-hidden="true" />
              </div>
            </button>
          );
        })}
      </div>
      <p className="ncj-cap">
        {frontFace.tier.finishName} finish, level {frontFace.level} of 10. Click a card behind to see another finish. Your own
        card is built from what you have done, and it matches only you.
      </p>
    </div>
  );
}

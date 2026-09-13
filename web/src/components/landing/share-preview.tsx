import { CardFront } from "@/components/card/card-front";
import { Seal } from "@/components/card/seal";
import type { CardFace } from "@/lib/card/view";

/**
 * Прев'ю картинок для X на головній: та сама композиція, що в lib/card/og.tsx,
 * зверстана в HTML (картинки справжніх карток малює og.tsx).
 */
export function SharePreview({ face, format, reasons }: { face: CardFace; format: "wide" | "tall"; reasons: string }) {
  const big = (
    <>
      {face.roleName} rated <span className="text-[#ff7a4d]">{face.score}</span>
    </>
  );
  return (
    <div
      role="img"
      aria-label={`Image for X, ${format === "wide" ? "1200 by 675" : "1080 by 1350"}: ${face.summary}`}
      className={`ncj-share ncj-share-${format}`}
    >
      {face.sealSeed !== null ? (
        <Seal
          seed={face.sealSeed}
          level={face.tier.sealLayers}
          density="share"
          inks={["#eef1f6", "#eef1f6"]}
          strokeWidth={0.45}
          className="ncj-share-rosette"
        />
      ) : null}
      <div className="ncj-share-card">
        <div className="ncj-card">
          <CardFront face={face} />
        </div>
      </div>
      <div className="ncj-share-copy">
        {format === "wide" ? (
          <>
            <div>
              <p className="ncj-share-big">{big}</p>
              <p className="ncj-share-sub">
                Level {face.level} of 10, {face.tier.finishName.toLowerCase()} finish. {reasons}
              </p>
            </div>
            <p className="ncj-share-foot">
              <span>SEASON 1</span>
              <span>NEXTCRYPTOJOB.XYZ</span>
            </p>
          </>
        ) : (
          <>
            <p className="ncj-share-big">{big}</p>
            <p className="ncj-share-foot">
              LEVEL {face.level} {face.tier.finishName.toUpperCase()} / NEXTCRYPTOJOB.XYZ
            </p>
          </>
        )}
      </div>
      {face.kind === "example" ? <span className="ncj-share-ex">EXAMPLE</span> : null}
    </div>
  );
}

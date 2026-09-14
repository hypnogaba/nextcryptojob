import { CardFront } from "@/components/card/card-front";
import type { CardFace } from "@/lib/card/view";

/**
 * Прев'ю картинки для X (1200×675): та сама композиція, що в lib/card/og.tsx, зверстана в
 * HTML. Лимонне поле, картка під кутом зліва, праворуч роль, бал і рівень, з чого бал.
 */
export function SharePreview({ face, reasons }: { face: CardFace; reasons: string }) {
  return (
    <div role="img" aria-label={`Image for X, 1200 by 675: ${face.summary}`} className="ncj-share">
      <div className="ncj-share-card">
        <div className="ncj-card">
          <CardFront face={{ ...face, kind: face.kind === "example" ? "draft" : face.kind }} />
        </div>
      </div>
      <div className="ncj-share-copy">
        <p className="ncj-share-who">{face.displayName}</p>
        <p className="ncj-share-big">{face.roleName}</p>
        <p className="ncj-share-rt">
          Rated {face.score} of 100. Level {face.level}.
        </p>
        {reasons ? <p className="ncj-share-sub">{reasons}</p> : null}
        <p className="ncj-share-url">nextcryptojob.xyz</p>
      </div>
    </div>
  );
}

// Картинки картки для X (next/og: Satori + resvg), напрям «Payday»:
// - "wide" 1200×675, картинка для допису; той самий макет на 1200×630 іде в og:image;
// - "tall" 1080×1350, портрет.
// Лимонне поле, банківська картка під кутом (обробка рівня, кругла печатка з рівнем),
// поруч роль, бал і рівень, з чого бал. Жоден текст не заходить у верхні й нижні 24 px,
// тож обрізання до 1.91:1 нічого не з'їдає.
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import cyrillic from "./fonts/ncj-cyrillic-600";
import funnelDisplay from "./fonts/funnel-display-700";
import funnelSans from "./fonts/funnel-sans-500";
import { builtFrom } from "./back";
import { makeSeal, sealDataUri } from "./seal";
import { tierBackground } from "./tiers";
import type { CardView } from "./view";

export type ShareFormat = "wide" | "tall" | "link";

export const SHARE_SIZES: Record<ShareFormat, { width: number; height: number }> = {
  wide: { width: 1200, height: 675 },
  tall: { width: 1080, height: 1350 },
  link: { width: 1200, height: 630 },
};

/** Розмір картинки Open Graph (посилання в X, Telegram, Slack). */
export const OG_SIZE = SHARE_SIZES.link;

const LEMON = "#ffdb2e";
const INK = "#111318";
const LEMON_INK = "#3d3300";

type Options = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;
type Fonts = NonNullable<Options["fonts"]>;

function decode(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// Порядок важливий: Satori шукає літеру спершу в названому шрифті, далі в решті.
// Кирилиця імені є лише в NCJ Card Cyrillic (з IBM Plex Sans), тож він останній.
const DISPLAY = "Funnel Display";
const TEXT = "Funnel Sans";
const CYRILLIC = "NCJ Card Cyrillic";

let fonts: Fonts | undefined;
function cardFonts(): Fonts {
  fonts ??= [
    { name: DISPLAY, data: decode(funnelDisplay), weight: 700, style: "normal" },
    { name: TEXT, data: decode(funnelSans), weight: 500, style: "normal" },
    { name: CYRILLIC, data: decode(cyrillic), weight: 600, style: "normal" },
  ];
  return fonts;
}

/** Довге ім'я дрібнішим кеглем: до 32 символів без обрізання на ширшій картці. */
export function nameFontSize(name: string, cardWidth: number): number {
  const length = [...name].length;
  const base = cardWidth * 0.042;
  return Math.round(length <= 18 ? base : length <= 24 ? base * 0.86 : base * 0.72);
}

const flex = (style: CSSProperties): CSSProperties => ({ display: "flex", ...style });

/** Кругла печатка з рівнем: розетка з того ж зерна, що на сторінці, і лимонне ядро. */
function Badge({ view, size, ring }: { view: CardView; size: number; ring: string }) {
  const t = view.tier;
  const seal = sealDataUri(makeSeal(view.sealSeed ?? 0, t.sealLayers), { inks: t.sealInks, strokeWidth: 1.1, size });
  const core = Math.round(size * 0.4);
  return (
    <div style={flex({ position: "relative", width: size, height: size, alignItems: "center", justifyContent: "center" })}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img> */}
      <img src={seal} alt="" width={size} height={size} style={{ position: "absolute", left: 0, top: 0 }} />
      <div
        style={flex({
          width: core,
          height: core,
          borderRadius: core,
          backgroundColor: LEMON,
          border: `${Math.round(size * 0.04)}px solid ${ring}`,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: INK,
        })}
      >
        <span style={{ fontFamily: TEXT, fontSize: Math.round(size * 0.075), letterSpacing: 1, lineHeight: 1 }}>LVL</span>
        <span style={{ fontFamily: DISPLAY, fontSize: Math.round(size * 0.17), lineHeight: 0.95 }}>{String(view.level)}</span>
      </div>
    </div>
  );
}

/** Картка для картинки: та сама анатомія, що на сторінці (components/card/card-front.tsx). */
function ShareCard({ view, width }: { view: CardView; width: number }) {
  const t = view.tier;
  const height = Math.round(width / 1.586);
  const u = (k: number) => Math.round(width * k);
  const stats = view.stats.slice(0, 3);
  return (
    <div
      style={flex({
        ...tierBackground(t),
        position: "relative",
        width,
        height,
        borderRadius: u(0.052),
        flexDirection: "column",
        justifyContent: "space-between",
        padding: `${u(0.062)}px ${u(0.07)}px ${u(0.056)}px`,
        color: t.ink,
        boxShadow: "0 36px 50px -20px rgba(77,62,0,0.55)",
      })}
    >
      <div style={flex({ flexDirection: "column" })}>
        <div style={flex({ alignItems: "center", fontFamily: DISPLAY, fontSize: u(0.043) })}>
          <div
            style={flex({
              width: u(0.056),
              height: u(0.056),
              borderRadius: u(0.056),
              backgroundColor: LEMON,
              alignItems: "center",
              justifyContent: "center",
              marginRight: u(0.018),
            })}
          >
            <div style={{ width: u(0.012), height: u(0.012), borderRadius: u(0.012), backgroundColor: INK }} />
          </div>
          NextCryptoJob
        </div>
        <span style={{ fontFamily: TEXT, fontSize: u(0.025), letterSpacing: u(0.002), color: t.ink2, marginTop: u(0.01) }}>
          {`SEASON 1 · ${(view.number ?? "").toUpperCase()}`}
        </span>
      </div>
      <div style={flex({ alignItems: "flex-end" })}>
        {/* Без від'ємного трекінгу: Satori міряє ширину без нього, і роль лізла б на число. */}
        <span style={{ fontFamily: DISPLAY, fontSize: u(0.24), lineHeight: 0.8, flexShrink: 0 }}>{String(view.score)}</span>
        <div style={flex({ flexDirection: "column", marginLeft: u(0.03), paddingBottom: u(0.006), maxWidth: u(0.5) })}>
          <span style={{ fontFamily: TEXT, fontSize: u(0.039), color: t.ink2 }}>of 100</span>
          <span style={{ fontFamily: DISPLAY, fontSize: u(0.048), lineHeight: 1.15 }}>{view.roleName}</span>
        </div>
      </div>
      <div style={flex({ justifyContent: "space-between", alignItems: "flex-end", marginTop: u(0.045) })}>
        <span
          style={{
            display: "block",
            fontFamily: `${DISPLAY}, ${CYRILLIC}`,
            fontSize: nameFontSize(view.displayName, width),
            letterSpacing: u(0.005),
            textTransform: "uppercase",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            maxWidth: stats.length > 0 ? u(0.5) : u(0.86),
          }}
        >
          {view.displayName}
        </span>
        {stats.length > 0 ? (
          <div style={flex({ fontFamily: TEXT, fontSize: u(0.03), color: t.ink2 })}>
            {stats.map((s) => (
              <div key={s.code} style={flex({ alignItems: "baseline", marginLeft: u(0.024) })}>
                <span>{s.code}</span>
                <span style={{ marginLeft: u(0.008), fontSize: u(0.035), color: s.value === null ? t.ink2 : t.ink }}>
                  {s.value === null ? "gap" : String(s.value)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div style={flex({ position: "absolute", top: u(0.044), right: u(0.048) })}>
        <Badge view={view} size={u(0.29)} ring={t.frame} />
      </div>
    </div>
  );
}

function reasonLine(view: CardView): string | null {
  return builtFrom(view.back);
}

/** 1200×675 або 1200×630: картка зліва під кутом, праворуч роль і бал. */
function Wide({ view, height }: { view: CardView; height: number }) {
  const W = 1200;
  const cardW = 540;
  const cardH = Math.round(cardW / 1.586);
  const big = view.roleName.length > 18 ? 52 : 64;
  const reasons = reasonLine(view);
  return (
    <div style={flex({ width: W, height, backgroundColor: LEMON, color: INK, position: "relative", overflow: "hidden" })}>
      <div style={flex({ position: "absolute", left: 64, top: Math.round((height - cardH) / 2), transform: "rotate(-6deg)" })}>
        <ShareCard view={view} width={cardW} />
      </div>
      <div
        style={flex({
          position: "absolute",
          left: 684,
          right: 60,
          top: 64,
          bottom: 64,
          flexDirection: "column",
          justifyContent: "center",
        })}
      >
        <span style={{ fontFamily: `${TEXT}, ${CYRILLIC}`, fontSize: 28, color: LEMON_INK }}>{view.displayName}</span>
        <span style={{ fontFamily: DISPLAY, fontSize: big, lineHeight: 1, letterSpacing: -2, marginTop: 10 }}>{view.roleName}</span>
        <span style={{ fontFamily: TEXT, fontSize: 30, marginTop: 14 }}>{`Rated ${view.score} of 100. Level ${view.level}.`}</span>
        {reasons ? (
          <span style={{ fontFamily: TEXT, fontSize: 23, lineHeight: 1.35, color: LEMON_INK, marginTop: 28 }}>{reasons}</span>
        ) : null}
        <span style={{ fontFamily: DISPLAY, fontSize: 28, marginTop: 36 }}>nextcryptojob.xyz</span>
      </div>
    </div>
  );
}

/** 1080×1350: картка вгорі, роль, бал і рівень унизу. */
function Tall({ view }: { view: CardView }) {
  const { width: W, height: H } = SHARE_SIZES.tall;
  const cardW = 800;
  const big = view.roleName.length > 18 ? 76 : 96;
  const reasons = reasonLine(view);
  return (
    <div style={flex({ width: W, height: H, backgroundColor: LEMON, color: INK, position: "relative", overflow: "hidden" })}>
      <div style={flex({ position: "absolute", left: (W - cardW) / 2, top: 190, transform: "rotate(-4deg)" })}>
        <ShareCard view={view} width={cardW} />
      </div>
      <div
        style={flex({
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 140,
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        })}
      >
        <span style={{ fontFamily: `${TEXT}, ${CYRILLIC}`, fontSize: 34, color: LEMON_INK }}>{view.displayName}</span>
        <span style={{ fontFamily: DISPLAY, fontSize: big, lineHeight: 1, letterSpacing: -3, marginTop: 12 }}>{view.roleName}</span>
        <span style={{ fontFamily: TEXT, fontSize: 38, marginTop: 18 }}>{`Rated ${view.score} of 100. Level ${view.level}.`}</span>
        {reasons ? (
          <span style={{ fontFamily: TEXT, fontSize: 28, lineHeight: 1.35, color: LEMON_INK, marginTop: 24 }}>{reasons}</span>
        ) : null}
        <span style={{ fontFamily: DISPLAY, fontSize: 34, marginTop: 40 }}>nextcryptojob.xyz</span>
      </div>
    </div>
  );
}

export function ShareImage({ view, format }: { view: CardView; format: ShareFormat }) {
  return format === "tall" ? <Tall view={view} /> : <Wide view={view} height={SHARE_SIZES[format].height} />;
}

export function renderCardImage(view: CardView, format: ShareFormat = "link"): ImageResponse {
  return new ImageResponse(<ShareImage view={view} format={format} />, {
    ...SHARE_SIZES[format],
    fonts: cardFonts(),
    // Картка може зникнути (відкликання, видалення акаунта), тож не «назавжди».
    headers: { "cache-control": "public, max-age=3600" },
  });
}

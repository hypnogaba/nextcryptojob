// Картинки картки для X (next/og: Satori + resvg), напрям D (згода власника 16.09):
// - "square" 1200×1200, ГОЛОВНА картинка для допису (у стрічці X квадрат займає найбільше
//   місця); "wide" 1200×675 і "link" 1200×630 ідуть в опенграф і кнопку 16:9; "tall" 1080×1350
//   портрет.
// Кругла гільош-печатка на квадратному аркуші замість банківської картки (раніше плутали з
// платіжкою): зверху зліва знак і сезон, у центрі кільце печатки з чистим диском (бал, роль,
// рівень), знизу підпис Name/номер/домен. Диск завжди непрозорий і малюється ПІСЛЯ печатки
// (z-index вище), тож лінії гільошу ніколи не проходять крізь цифри.
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import { nameFitsOneLine, nameFontScale } from "./display-name";
import cyrillic from "./fonts/ncj-cyrillic-600";
import funnelDisplay from "./fonts/funnel-display-700";
import funnelSans from "./fonts/funnel-sans-500";
import { builtFrom } from "./back";
import { makeSeal, sealDataUri } from "./seal";
import { tierBackground } from "./tiers";
import type { CardView } from "./view";

export type ShareFormat = "wide" | "tall" | "square" | "link";

export const SHARE_SIZES: Record<ShareFormat, { width: number; height: number }> = {
  wide: { width: 1200, height: 675 },
  tall: { width: 1080, height: 1350 },
  square: { width: 1200, height: 1200 },
  link: { width: 1200, height: 630 },
};

/** Розмір картинки Open Graph (посилання в X, Telegram, Slack). */
export const OG_SIZE = SHARE_SIZES.link;

const PAGE_BG = "#ffffff";
const INK = "#0e0f12";
const INK_MUTED = "#5d616b";
const LINE = "#e8e9ec";

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

/** Довге ім'я дрібнішим кеглем (K2): до 32 символів без обрізання на ширшій картці. */
export function nameFontSize(name: string, cardWidth: number): number {
  return Math.round(cardWidth * 0.042 * nameFontScale(name));
}

const flex = (style: CSSProperties): CSSProperties => ({ display: "flex", ...style });

/**
 * Печатка як окрема картинка: гільош-кільце фіксованого розміру. Товщину лінії рахуємо
 * від розміру кільця, інакше на великому квадраті лінія, підібрана під стару маленьку
 * картку, виглядала б товстим канатом.
 */
function sealImage(view: CardView, ring: number): string {
  const t = view.tier;
  const strokeWidth = Math.max(0.28, 240 / ring);
  return sealDataUri(makeSeal(view.sealSeed ?? 0, t.sealLayers, "dense"), { inks: t.sealInks, strokeWidth, size: ring });
}

/**
 * Аркуш з печаткою (напрям D): та сама анатомія в HTML-картці (components/card/card-front.tsx)
 * і тут: знак і сезон зверху зліва, кільце печатки з диском (бал, роль, рівень) у центрі,
 * ім'я й номер знизу. Квадратний, тож `size` задає і ширину, і висоту.
 */
export function SealCard({ view, size }: { view: CardView; size: number }) {
  const t = view.tier;
  const u = (k: number) => Math.round(size * k);
  const ring = u(0.7);
  const disc = u(0.41);
  const halo = u(0.017);
  const ringBorder = u(0.045);
  const seal = sealImage(view, ring);
  return (
    <div
      style={flex({
        ...tierBackground(t),
        position: "relative",
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        color: t.ink,
      })}
    >
      <div style={flex({ position: "absolute", top: u(0.047), left: u(0.053), flexDirection: "column" })}>
        <span
          style={{
            fontFamily: DISPLAY,
            fontSize: u(0.03),
            fontWeight: 700,
            letterSpacing: u(0.004),
            textTransform: "uppercase",
            color: t.ink,
          }}
        >
          NextCryptoJob
        </span>
        <span
          style={{
            fontFamily: TEXT,
            fontSize: u(0.018),
            letterSpacing: u(0.003),
            textTransform: "uppercase",
            color: t.ink2,
            marginTop: u(0.006),
          }}
        >
          {`Season 1 · ${t.finishName}`}
        </span>
      </div>
      <div style={flex({ position: "relative", width: ring, height: ring, alignItems: "center", justifyContent: "center" })}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img> */}
        <img src={seal} alt="" width={ring} height={ring} style={{ position: "absolute", top: 0, left: 0, zIndex: 1 }} />
        <div
          style={{
            position: "absolute",
            top: ringBorder,
            left: ringBorder,
            right: ringBorder,
            bottom: ringBorder,
            border: `${Math.max(1, u(0.0025))}px solid ${t.hairline}`,
            borderRadius: ring,
            zIndex: 2,
          }}
        />
        {/* Диск понад печаткою (zIndex 3): непрозорий, тож лінії гільошу не заходять на цифри. */}
        <div
          style={flex({
            position: "relative",
            zIndex: 3,
            width: disc,
            height: disc,
            borderRadius: disc,
            backgroundColor: t.window,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: `0 0 0 ${halo}px ${t.window}`,
          })}
        >
          <span style={{ fontFamily: DISPLAY, fontSize: u(0.165), lineHeight: 0.85, fontWeight: 700, color: t.ink }}>
            {String(view.score)}
          </span>
          <span
            style={{
              fontFamily: TEXT,
              fontSize: u(0.019),
              letterSpacing: u(0.0023),
              textTransform: "uppercase",
              color: t.ink2,
              marginTop: u(0.005),
            }}
          >
            of 100
          </span>
          <span style={{ fontFamily: DISPLAY, fontSize: u(0.036), fontWeight: 700, color: t.ink, marginTop: u(0.013) }}>
            {view.roleName}
          </span>
          <span style={{ fontFamily: TEXT, fontSize: u(0.0205), color: t.ink2 }}>{`Level ${view.level} of 10`}</span>
        </div>
      </div>
      <div
        style={flex({
          position: "absolute",
          bottom: u(0.047),
          left: u(0.053),
          right: u(0.053),
          justifyContent: "space-between",
          alignItems: "flex-end",
        })}
      >
        <div style={flex({ flexDirection: "column", maxWidth: u(0.5) })}>
          <span
            style={{ fontFamily: TEXT, fontSize: u(0.017), letterSpacing: u(0.003), textTransform: "uppercase", color: t.ink2 }}
          >
            Name
          </span>
          <span
            style={{
              fontFamily: `${DISPLAY}, ${CYRILLIC}`,
              fontSize: nameFontSize(view.displayName, size),
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: u(0.003),
              textTransform: "uppercase",
              color: t.ink,
              marginTop: u(0.003),
              // K2: кегель підібраний під довжину (nameFontScale), тож ім'я стоїть в один рядок
              // і ніколи не обрізається «…».
              whiteSpace: nameFitsOneLine(view.displayName) ? "nowrap" : "normal",
              overflowWrap: "break-word",
            }}
          >
            {view.displayName}
          </span>
        </div>
        <div style={flex({ flexDirection: "column", alignItems: "flex-end" })}>
          <span style={{ fontFamily: TEXT, fontSize: u(0.019), color: t.ink2 }}>{view.number ?? ""}</span>
          <span style={{ fontFamily: TEXT, fontSize: u(0.019), color: t.ink2 }}>nextcryptojob.xyz</span>
        </div>
      </div>
    </div>
  );
}

function reasonLine(view: CardView): string | null {
  return builtFrom(view.back);
}

/** 1200×1200: головна картинка для допису, аркуш з печаткою на все полотно. */
function Square({ view }: { view: CardView }) {
  const { width } = SHARE_SIZES.square;
  return <SealCard view={view} size={width} />;
}

/** 1200×675 або 1200×630: аркуш з печаткою зліва, роль і бал текстом праворуч. */
function Wide({ view, height }: { view: CardView; height: number }) {
  const W = 1200;
  const margin = 64;
  const gap = 80;
  const cardSize = Math.min(520, height - margin * 2);
  const big = view.roleName.length > 18 ? 52 : 64;
  const reasons = reasonLine(view);
  return (
    <div style={flex({ width: W, height, backgroundColor: PAGE_BG, color: INK, position: "relative", overflow: "hidden", border: `2px solid ${LINE}` })}>
      <div style={flex({ position: "absolute", left: margin, top: Math.round((height - cardSize) / 2) })}>
        <SealCard view={view} size={cardSize} />
      </div>
      <div
        style={flex({
          position: "absolute",
          left: margin + cardSize + gap,
          right: 60,
          top: margin,
          bottom: margin,
          flexDirection: "column",
          justifyContent: "center",
        })}
      >
        <span style={{ fontFamily: `${TEXT}, ${CYRILLIC}`, fontSize: 28, color: INK_MUTED }}>{view.displayName}</span>
        <span style={{ fontFamily: DISPLAY, fontSize: big, lineHeight: 1, letterSpacing: -2, marginTop: 10 }}>{view.roleName}</span>
        <span style={{ fontFamily: TEXT, fontSize: 30, marginTop: 14 }}>{`Rated ${view.score} of 100. Level ${view.level}.`}</span>
        {reasons ? (
          <span style={{ fontFamily: TEXT, fontSize: 23, lineHeight: 1.35, color: INK_MUTED, marginTop: 28 }}>{reasons}</span>
        ) : null}
        <span style={{ fontFamily: DISPLAY, fontSize: 28, marginTop: 36 }}>nextcryptojob.xyz</span>
      </div>
    </div>
  );
}

/** 1080×1350: аркуш з печаткою вгорі, роль, бал і рівень унизу. */
function Tall({ view }: { view: CardView }) {
  const { width: W, height: H } = SHARE_SIZES.tall;
  // Менший за ширину полотна: квадратний аркуш нижче за стару банківську картку тієї ж
  // ширини, тож звужуємо його, інакше довге ім'я й причини балу під ним налазять на аркуш.
  const cardSize = 600;
  const top = 110;
  const big = view.roleName.length > 18 ? 76 : 96;
  const reasons = reasonLine(view);
  return (
    <div style={flex({ width: W, height: H, backgroundColor: PAGE_BG, color: INK, position: "relative", overflow: "hidden", border: `2px solid ${LINE}` })}>
      <div style={flex({ position: "absolute", left: Math.round((W - cardSize) / 2), top })}>
        <SealCard view={view} size={cardSize} />
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
        <span style={{ fontFamily: `${TEXT}, ${CYRILLIC}`, fontSize: 34, color: INK_MUTED }}>{view.displayName}</span>
        <span style={{ fontFamily: DISPLAY, fontSize: big, lineHeight: 1, letterSpacing: -3, marginTop: 12 }}>{view.roleName}</span>
        <span style={{ fontFamily: TEXT, fontSize: 38, marginTop: 18 }}>{`Rated ${view.score} of 100. Level ${view.level}.`}</span>
        {reasons ? (
          <span style={{ fontFamily: TEXT, fontSize: 28, lineHeight: 1.35, color: INK_MUTED, marginTop: 24 }}>{reasons}</span>
        ) : null}
        <span style={{ fontFamily: DISPLAY, fontSize: 34, marginTop: 40 }}>nextcryptojob.xyz</span>
      </div>
    </div>
  );
}

export function ShareImage({ view, format }: { view: CardView; format: ShareFormat }) {
  if (format === "tall") return <Tall view={view} />;
  if (format === "square") return <Square view={view} />;
  return <Wide view={view} height={SHARE_SIZES[format].height} />;
}

export function renderCardImage(view: CardView, format: ShareFormat = "link"): ImageResponse {
  return new ImageResponse(<ShareImage view={view} format={format} />, {
    ...SHARE_SIZES[format],
    fonts: cardFonts(),
    // Картка може зникнути (відкликання, видалення акаунта), тож не «назавжди».
    headers: { "cache-control": "public, max-age=3600" },
  });
}

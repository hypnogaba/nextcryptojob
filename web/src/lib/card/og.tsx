// Картинки картки для X (next/og: Satori + resvg):
// - "wide" 1200×675, картинка для допису; той самий макет на 1200×630 іде в og:image;
// - "tall" 1080×1350, портрет.
// Тло темне, картка під кутом зліва (обробка рівня, печатка), праворуч заголовок.
// Велика рідка розетка з того ж зерна виходить за край: на мініатюрі вона
// читається як малюнок, а не сіра пляма. Жоден текст не заходить у верхні й
// нижні 24 px, тож обрізання до 1.91:1 нічого не з'їдає.
import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";
import bigShoulders from "./fonts/big-shoulders-800";
import familjen from "./fonts/familjen-grotesk-500";
import cyrillic from "./fonts/ncj-cyrillic-600";
import { builtFrom } from "./back";
import { makeSeal, sealDataUri, underprintDataUri } from "./seal";
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

const BG = "#0f1829";
const FG = "#eef1f6";
const FG_2 = "#c2cbd9";
const ACCENT = "#ff7a4d";

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
const DISPLAY = "Big Shoulders";
const TEXT = "Familjen Grotesk";
const CYRILLIC = "NCJ Card Cyrillic";

let fonts: Fonts | undefined;
function cardFonts(): Fonts {
  fonts ??= [
    { name: DISPLAY, data: decode(bigShoulders), weight: 800, style: "normal" },
    { name: TEXT, data: decode(familjen), weight: 500, style: "normal" },
    { name: CYRILLIC, data: decode(cyrillic), weight: 600, style: "normal" },
  ];
  return fonts;
}

/** Довге ім'я дрібнішим кеглем: до 32 символів без обрізання на ширшій картці. */
export function nameFontSize(name: string, cardWidth: number): number {
  const length = [...name].length;
  const base = cardWidth * 0.074;
  return Math.round(length <= 16 ? base : length <= 22 ? base * 0.82 : base * 0.66);
}

const flex = (style: CSSProperties): CSSProperties => ({ display: "flex", ...style });

/** Картка для картинки: та сама анатомія, що на сторінці (components/card/card-front.tsx). */
function ShareCard({ view, width }: { view: CardView; width: number }) {
  const t = view.tier;
  const height = Math.round(width / 0.718);
  const pad = Math.round(width * 0.055);
  const inner = width - 2 * pad;
  const winPad = Math.round(inner * 0.07);
  const artSide = Math.round(inner * 0.62);
  const dark = t.finish === "black" || t.finish === "red_seal";
  const seal = sealDataUri(makeSeal(view.sealSeed ?? 0, t.sealLayers, "share"), {
    inks: t.sealInks,
    strokeWidth: 1.5,
    size: artSide,
  });
  const u = (k: number) => Math.round(width * k);
  return (
    <div
      style={flex({
        ...tierBackground(t),
        width,
        height,
        padding: pad,
        borderRadius: `${u(0.0455)}px / ${Math.round(height * 0.035)}px`,
        position: "relative",
        boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
      })}
    >
      <div
        style={flex({
          flexDirection: "column",
          width: inner,
          height: height - 2 * pad,
          padding: winPad,
          backgroundColor: t.window,
          borderRadius: u(0.028),
          color: t.ink,
        })}
      >
        <div style={flex({ justifyContent: "space-between", alignItems: "flex-start" })}>
          <div style={flex({ flexDirection: "column" })}>
            <span style={{ fontFamily: DISPLAY, fontSize: u(0.25), lineHeight: 0.8 }}>{String(view.score)}</span>
            <span style={{ fontFamily: DISPLAY, fontSize: u(0.079), lineHeight: 1, marginTop: u(0.016) }}>
              {view.positionCode}
            </span>
          </div>
          <div style={flex({ flexDirection: "column", alignItems: "flex-end", fontFamily: DISPLAY, color: t.ink2 })}>
            <span style={{ fontSize: u(0.042) }}>LEVEL</span>
            <span style={{ fontSize: u(0.09), lineHeight: 1, color: t.ink }}>{String(view.level)}</span>
            <span style={{ fontSize: u(0.042) }}>{t.finishName.toUpperCase()}</span>
          </div>
        </div>
        <div style={flex({ flexGrow: 1, alignItems: "center", justifyContent: "center", position: "relative", margin: `${u(0.02)}px 0` })}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img> */}
          <img
            src={underprintDataUri(dark ? "#a9adb2" : "#5d6166", dark ? 0.16 : 0.2)}
            alt=""
            width={inner - 2 * winPad}
            height={artSide}
            style={{ position: "absolute", left: 0, top: 0 }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img> */}
          <img src={seal} alt="" width={artSide} height={artSide} />
        </div>
        <div
          style={{
            display: "block",
            fontFamily: `${DISPLAY}, ${CYRILLIC}`,
            fontSize: nameFontSize(view.displayName, width),
            lineHeight: 1.1,
            textTransform: "uppercase",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {view.displayName}
        </div>
        {view.stats.length > 0 ? (
          <div style={flex({ flexWrap: "wrap", marginTop: u(0.02), fontFamily: DISPLAY })}>
            {view.stats.map((s) => (
              <div
                key={s.code}
                style={flex({
                  width: "30.5%",
                  alignItems: "baseline",
                  borderTop: `${Math.max(2, u(0.004))}px solid ${t.ink}`,
                  paddingTop: u(0.008),
                  marginRight: "2.5%",
                  marginTop: u(0.006),
                })}
              >
                <span style={{ fontSize: s.value === null ? u(0.036) : u(0.058), color: s.value === null ? t.ink2 : t.ink }}>
                  {s.value === null ? "gap" : String(s.value)}
                </span>
                <span style={{ fontSize: u(0.034), marginLeft: u(0.013) }}>{s.code}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {view.marker ? (
        <span
          style={{
            position: "absolute",
            left: u(0.07),
            top: Math.round(height * 0.012),
            fontFamily: DISPLAY,
            fontSize: u(0.031),
            letterSpacing: u(0.003),
            padding: `0 ${u(0.016)}px`,
            backgroundColor: t.window,
            color: t.ink,
          }}
        >
          {view.marker.toUpperCase()}
        </span>
      ) : null}
      <div
        style={flex({
          position: "absolute",
          left: u(0.07),
          right: u(0.07),
          bottom: Math.round(height * 0.012),
          justifyContent: "space-between",
          fontFamily: DISPLAY,
          fontSize: u(0.031),
          letterSpacing: u(0.0025),
          color: t.frameInk,
        })}
      >
        <span>SEASON 1</span>
        <span>{view.number ?? ""}</span>
      </div>
    </div>
  );
}

function Rosette({ view, size, left, top }: { view: CardView; size: number; left: number; top: number }) {
  const uri = sealDataUri(makeSeal(view.sealSeed ?? 0, view.tier.sealLayers, "share"), {
    inks: [FG, FG],
    strokeWidth: 0.45,
    size,
    opacity: 0.1,
  });
  // eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img>
  return <img src={uri} alt="" width={size} height={size} style={{ position: "absolute", left, top }} />;
}

function Headline({ view, size, center = false }: { view: CardView; size: number; center?: boolean }) {
  return (
    <div
      style={flex({
        flexWrap: "wrap",
        justifyContent: center ? "center" : "flex-start",
        fontFamily: DISPLAY,
        fontSize: size,
        lineHeight: 0.88,
        textTransform: "uppercase",
      })}
    >
      <span style={{ marginRight: size * 0.22 }}>{view.roleName}</span>
      <span style={{ marginRight: size * 0.22 }}>rated</span>
      <span style={{ color: ACCENT }}>{String(view.score)}</span>
    </div>
  );
}

function reasonLine(view: CardView): string {
  const parts = [`Level ${view.level} of 10, ${view.tier.finishName.toLowerCase()} finish.`];
  const built = builtFrom(view.back);
  if (built) parts.push(built);
  if (view.marker) parts.push(`${view.marker}.`);
  return parts.join(" ");
}

/** 1200×675 або 1200×630: картка зліва, заголовок праворуч. */
function Wide({ view, height }: { view: CardView; height: number }) {
  const W = 1200;
  const cardH = Math.round(height * 0.8);
  const cardW = Math.round(cardH * 0.718);
  const head = view.roleName.length > 18 ? 76 : 92;
  return (
    <div style={flex({ width: W, height, backgroundColor: BG, color: FG, position: "relative", overflow: "hidden" })}>
      <Rosette view={view} size={780} left={W - 560} top={Math.round(height / 2 - 400)} />
      <div style={flex({ position: "absolute", left: 72, top: Math.round((height - cardH) / 2), transform: "rotate(-4deg)" })}>
        <ShareCard view={view} width={cardW} />
      </div>
      <div
        style={flex({
          position: "absolute",
          left: 540,
          right: 64,
          top: 72,
          bottom: 64,
          flexDirection: "column",
          justifyContent: "space-between",
        })}
      >
        <div style={flex({ flexDirection: "column" })}>
          <Headline view={view} size={head} />
          <div style={{ display: "block", fontFamily: TEXT, fontSize: 26, lineHeight: 1.35, color: FG_2, marginTop: 24 }}>
            {reasonLine(view)}
          </div>
        </div>
        <div style={flex({ justifyContent: "space-between", fontFamily: DISPLAY, fontSize: 24, letterSpacing: 1.5, color: FG_2 })}>
          <span>SEASON 1</span>
          <span>NEXTCRYPTOJOB.XYZ</span>
        </div>
      </div>
    </div>
  );
}

/** 1080×1350: картка вгорі, заголовок і рівень унизу. */
function Tall({ view }: { view: CardView }) {
  const { width: W, height: H } = SHARE_SIZES.tall;
  const cardW = 580;
  const head = view.roleName.length > 18 ? 92 : 112;
  return (
    <div style={flex({ width: W, height: H, backgroundColor: BG, color: FG, position: "relative", overflow: "hidden" })}>
      <Rosette view={view} size={1040} left={20} top={-120} />
      <div style={flex({ position: "absolute", left: (W - cardW) / 2, top: 84, transform: "rotate(-3deg)" })}>
        <ShareCard view={view} width={cardW} />
      </div>
      <div
        style={flex({
          position: "absolute",
          left: 72,
          right: 72,
          bottom: 80,
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        })}
      >
        <Headline view={view} size={head} center />
        <div style={{ display: "block", fontFamily: DISPLAY, fontSize: 34, letterSpacing: 2, color: FG_2, marginTop: 28 }}>
          {`LEVEL ${view.level} ${view.tier.finishName.toUpperCase()} / NEXTCRYPTOJOB.XYZ`}
        </div>
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

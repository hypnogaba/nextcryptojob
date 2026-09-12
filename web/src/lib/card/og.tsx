// Картинка картки для X і Open Graph: 1200×630, next/og (Satori + resvg).
// Композиція як на сторінці: колір ступеня з візерунком, біла плашка з текстом.
// Увесь дрібний текст стоїть на суцільному білому або на `base` ступеня, тож
// контраст не залежить від градієнта (див. tiers.ts).
import { ImageResponse } from "next/og";
import plexMono from "./fonts/plex-mono-500";
import plexSans from "./fonts/plex-sans-600";
import unbounded from "./fonts/unbounded-600";
import { PATTERN_HEIGHT, PATTERN_WIDTH } from "./pattern";
import type { CardView } from "./view";

export const OG_SIZE = { width: PATTERN_WIDTH, height: PATTERN_HEIGHT } as const;

// Світлі токени з globals.css: плашка на картинці завжди світла.
const INK = "#141A1B";
const INK_MUTED = "#58646A";
const PLATE = "#FFFFFF";

type Options = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;
type Fonts = NonNullable<Options["fonts"]>;

function decode(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let fonts: Fonts | undefined;
function cardFonts(): Fonts {
  fonts ??= [
    { name: "Unbounded", data: decode(unbounded), weight: 600, style: "normal" },
    { name: "Plex Sans", data: decode(plexSans), weight: 600, style: "normal" },
    { name: "Plex Mono", data: decode(plexMono), weight: 500, style: "normal" },
  ];
  return fonts;
}

/** Довге ім'я дрібнішим кеглем, щоб до 32 символів влазило в плашку без обрізання. */
export function nameFontSize(name: string): number {
  const length = [...name].length;
  return length <= 18 ? 44 : length <= 24 ? 38 : 30;
}

export function CardImage({ view }: { view: CardView }) {
  return (
    <div
      style={{
        ...view.background,
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        display: "flex",
        position: "relative",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori малює лише <img>, не next/image */}
      <img
        src={view.patternSrc}
        alt=""
        width={OG_SIZE.width}
        height={OG_SIZE.height}
        style={{ position: "absolute", left: 0, top: 0 }}
      />

      <div
        style={{
          position: "absolute",
          left: 48,
          top: 48,
          width: 680,
          height: 534,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "44px 52px",
          backgroundColor: PLATE,
          borderRadius: 28,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: "Plex Mono",
            fontSize: 24,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: INK_MUTED,
          }}
        >
          {view.roleName}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <span style={{ fontFamily: "Unbounded", fontSize: 176, lineHeight: 1, letterSpacing: -4 }}>
              {String(view.score)}
            </span>
            <span
              style={{ fontFamily: "Plex Mono", fontSize: 34, color: INK_MUTED, marginLeft: 14, marginBottom: 14 }}
            >
              /100
            </span>
          </div>
          <div style={{ display: "flex", marginTop: 28 }}>
            <span
              style={{
                display: "flex",
                fontFamily: "Plex Mono",
                fontSize: 28,
                padding: "8px 18px",
                borderRadius: 10,
                backgroundColor: view.tier.base,
                color: view.tier.ink,
              }}
            >
              {view.levelLabel}
            </span>
          </div>
        </div>

        <div
          style={{
            display: "block",
            fontFamily: "Plex Sans",
            fontSize: nameFontSize(view.displayName),
            fontWeight: 600,
            lineHeight: 1.2,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {view.displayName}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          right: 48,
          bottom: 48,
          display: "flex",
          fontFamily: "Plex Mono",
          fontSize: 22,
          padding: "10px 16px",
          borderRadius: 10,
          backgroundColor: PLATE,
          color: INK,
        }}
      >
        nextcryptojob.xyz
      </div>
    </div>
  );
}

export function renderCardImage(view: CardView): ImageResponse {
  return new ImageResponse(<CardImage view={view} />, {
    ...OG_SIZE,
    fonts: cardFonts(),
    // Картка може зникнути (відкликання, видалення акаунта), тож не «назавжди».
    headers: { "cache-control": "public, max-age=3600" },
  });
}

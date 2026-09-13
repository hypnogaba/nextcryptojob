// Печатка картки: гільош-розетка, намальована з гаманця людини.
//
// Зерно: FNV-1a (як у pattern.ts) від підтвердженого гаманця, а без нього від
// slug картки. Той самий гаманець завжди дає ту саму печатку, тож скопійована
// картка виглядає чужою поруч зі справжньою. Шарів стільки, скільки рівень: з
// ростом рівня печатка густішає, а перші шари лишаються тими самими.
//
// Шар: z(t) = e^{iφ}·(A·e^{it} + B·e^{i(m+1)t}), m пелюсток. Це формула розетки
// x=(R+r)cos t+(r+p)cos((R+r)/r·t), y=(R+r)sin t−(r+p)sin((R+r)/r·t) (binarymax/guilloche,
// лише математика) з цілим m: крива замикається і має симетрію порядку m,
// бо z(t + 2π/m) = e^{i2π/m}·z(t). Тому досить однієї пелюстки й m поворотів:
// сторінка кладе пелюстку в <defs> і повторює її <use>, а картинка для X
// отримує повну криву (resvg у Worker краще без <use>).
// Криві Безьє з вузлів Ерміта: вузол і дотична з похідної, тож 6 відрізків на
// пелюстку дають гладку лінію без сотень точок.
import { fnv1a, mulberry32 } from "./pattern";

/** viewBox печатки: -100..100. */
export const SEAL_BOX = 100;
/** Зовнішній шар займає 92 з 100, щоб лінія не торкалась краю. */
const OUTER = 92;
/** Кожен наступний шар менший на 8.5% від зовнішнього. */
const STEP = 0.085;

export type SealDensity = "page" | "share";

export type SealLayer = {
  /** Кількість пелюсток (порядок симетрії). */
  petals: number;
  /** Радіус основного кола. */
  a: number;
  /** Радіус пера. */
  b: number;
  /** Поворот шару, радіани. */
  phase: number;
};

/** Зерно печатки. Гаманець важливіший за slug; адресу EVM зводимо до нижнього регістру. */
export function sealSeed(source: { wallet?: string | null; slug?: string | null }): number {
  const wallet = source.wallet?.trim();
  if (wallet) return fnv1a(`wallet:${/^0x/i.test(wallet) ? wallet.toLowerCase() : wallet}`);
  const slug = source.slug?.trim();
  if (slug) return fnv1a(`card:${slug}`);
  throw new Error("A seal needs a wallet or a card slug.");
}

/**
 * Шари печатки. `density: "share"` для картинки X: удвічі менше пелюсток,
 * інакше на мініатюрі розетка злипається в сіру пляму. Решта та сама.
 */
export function makeSeal(seed: number, level: number, density: SealDensity = "page"): SealLayer[] {
  if (!Number.isFinite(level)) throw new RangeError(`level must be a finite number, got ${level}`);
  const layers = Math.min(10, Math.max(1, Math.trunc(level)));
  const rand = mulberry32(seed);
  const out: SealLayer[] = [];
  for (let i = 0; i < layers; i++) {
    const pagePetals = 8 + Math.floor(rand() * 18); // 8..25
    const ratio = 0.14 + rand() * 0.46; // перо 0.14..0.6 від основного кола
    const turn = rand();
    const petals = density === "share" ? 5 + Math.floor((pagePetals - 8) / 2) : pagePetals;
    const reach = OUTER * (1 - i * STEP);
    const a = reach / (1 + ratio);
    out.push({ petals, a, b: a * ratio, phase: (turn * 2 * Math.PI) / petals });
  }
  return out;
}

type Pt = [number, number];

function at(l: SealLayer, t: number): { p: Pt; d: Pt } {
  const k = l.petals + 1;
  const c1 = Math.cos(t + l.phase), s1 = Math.sin(t + l.phase);
  const ck = Math.cos(k * t + l.phase), sk = Math.sin(k * t + l.phase);
  return {
    p: [l.a * c1 + l.b * ck, l.a * s1 + l.b * sk],
    d: [-l.a * s1 - k * l.b * sk, l.a * c1 + k * l.b * ck],
  };
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

/** Відрізок кривої t0..t1 як «C …» (без «M»). */
function arc(l: SealLayer, t0: number, t1: number, segments: number): string {
  const h = (t1 - t0) / segments;
  let out = "";
  let prev = at(l, t0);
  for (let s = 1; s <= segments; s++) {
    const next = at(l, t0 + s * h);
    const c1: Pt = [prev.p[0] + (prev.d[0] * h) / 3, prev.p[1] + (prev.d[1] * h) / 3];
    const c2: Pt = [next.p[0] - (next.d[0] * h) / 3, next.p[1] - (next.d[1] * h) / 3];
    out += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(next.p[0])} ${f(next.p[1])}`;
    prev = next;
  }
  return out;
}

/** Одна пелюстка (t від 0 до 2π/m). Решта шару = її повороти на 360/m градусів. */
export function petalPath(l: SealLayer, segments = 6): string {
  const start = at(l, 0).p;
  return `M${f(start[0])} ${f(start[1])}` + arc(l, 0, (2 * Math.PI) / l.petals, segments);
}

/** Увесь шар однією замкненою кривою. */
export function layerPath(l: SealLayer, segments = 6): string {
  const start = at(l, 0).p;
  let d = `M${f(start[0])} ${f(start[1])}`;
  const step = (2 * Math.PI) / l.petals;
  for (let k = 0; k < l.petals; k++) d += arc(l, k * step, (k + 1) * step, segments);
  return `${d}Z`;
}

/** Кут повороту k-ї пелюстки, градуси. */
export function petalAngle(l: SealLayer, k: number): number {
  return Math.round((360 * k * 100) / l.petals) / 100;
}

/**
 * Печатка як SVG-рядок з повними кривими: для картинки X (data:-адреса в <img>).
 * Колір і товщина на кожному шляху, бо resvg у Worker не завжди успадковує їх від групи.
 */
export function sealSvg(
  layers: SealLayer[],
  opts: { inks: readonly [string, string]; strokeWidth: number; size: number; opacity?: number },
): string {
  const paths = layers
    .map(
      (l, i) =>
        `<path d="${layerPath(l, 8)}" fill="none" stroke="${opts.inks[i % 2]}" stroke-width="${opts.strokeWidth}" ` +
        `stroke-opacity="${opts.opacity ?? 1}" stroke-linejoin="round"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-${SEAL_BOX} -${SEAL_BOX} ${2 * SEAL_BOX} ${2 * SEAL_BOX}" ` +
    `width="${opts.size}" height="${opts.size}">${paths}</svg>`
  );
}

export function sealDataUri(layers: SealLayer[], opts: Parameters<typeof sealSvg>[1]): string {
  return `data:image/svg+xml;base64,${btoa(sealSvg(layers, opts))}`;
}

/**
 * Хвилі підкладки (як нижній друк захищеного паперу): ледь помітні лінії під
 * печаткою. Не залежать від людини, тож одна data:-адреса на колір.
 */
export function underprintSvg(color: string, opacity: number, width = 240, height = 160, gap = 9): string {
  const lines: string[] = [];
  for (let y = -gap; y < height + gap; y += gap) {
    let d = "";
    for (let x = 0; x <= width; x += 8) {
      const yy = y + Math.sin(x / 38 + y / 50) * 6 + Math.sin(x / 11) * 1.2;
      d += `${d ? "L" : "M"}${x} ${yy.toFixed(1)}`;
    }
    lines.push(`<path d="${d}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="0.8"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `preserveAspectRatio="xMidYMid slice">${lines.join("")}</svg>`
  );
}

export function underprintDataUri(color: string, opacity: number): string {
  return `data:image/svg+xml;base64,${btoa(underprintSvg(color, opacity))}`;
}

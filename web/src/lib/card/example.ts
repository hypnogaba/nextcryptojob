// Приклад картки для головної: вигадана людина, справжня формула v6 (інженер у v6 такий самий, як у v5).
// Engineer: GitHub 74.2 (вага 80), X 46.3 (вага 20), додаток onchain 91.7 (до 5),
// сайту немає. Ядро 68.6 + додаток 4.6 = 73.2, на картці 73, рівень 8 (Chrome).
// Лише звідси береться kind: "example", тож позначка EXAMPLE не потрапить на справжню картку.
import type { Breakdown } from "@/lib/score/explain";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { cardBack } from "./back";
import { sealSeed } from "./seal";
import { displayScore, levelFor, tierFor } from "./tiers";
import { summaryOf, type CardFace } from "./view";

export const EXAMPLE_BREAKDOWN: Breakdown = {
  formula: "v6",
  core: { gh_eng: { weight: 80, value: 74.2 }, x: { weight: 20, value: 46.3 } },
  bonus: { onchain: { max: 5, value: 91.7 }, site: { max: 5, value: null } },
  cover: 100,
  level: 8,
  reason: null,
  gaps: {},
};

export const EXAMPLE_SCORE = 73.2;
/** Вигаданий гаманець прикладу: з нього печатка, як і в справжніх карток. */
const EXAMPLE_WALLET = "0x7a3f00000000000000000000000000000000c91e";

export const EXAMPLE_BACK = cardBack(EXAMPLE_BREAKDOWN, new Set(["github", "x", "evm"] as const))!;

/** Приклад з будь-яким рівнем: для драбини обробок на головній. */
export function exampleFace(level?: number): CardFace {
  const lv = level ?? levelFor(EXAMPLE_SCORE);
  const score = level ? Math.min(100, (lv - 1) * 10 + 3) : displayScore(EXAMPLE_SCORE);
  const face: CardFace = {
    kind: "example",
    roleName: "Engineer",
    positionCode: POSITION_CODE.engineer,
    score,
    level: lv,
    tier: tierFor(lv),
    displayName: "@kestrel.dev",
    sealSeed: sealSeed({ wallet: EXAMPLE_WALLET }),
    number: "No. kSt7rEl0dv",
    marker: null,
    summary: "",
  };
  face.summary = `Example card. ${summaryOf(face)}`;
  return face;
}

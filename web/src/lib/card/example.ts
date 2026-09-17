// Приклад картки для головної: вигадана людина, справжня формула v7.
// Engineer: робота GitHub 82 (40 балів) і GitHub projects 80 (20) = 48.8; репутація 70 (до 25) = 17.5;
// ширина onchain 91.7 і X 46.3 (по 5) = 6.9. Разом 73.2, на картці 73, рівень 8 (Chrome).
// Лише звідси береться kind: "example", тож позначка EXAMPLE не потрапить на справжню картку.
import type { Breakdown } from "@/lib/score/explain";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { cardBack } from "./back";
import { sealSeed } from "./seal";
import { displayScore, levelFor, tierFor } from "./tiers";
import { summaryOf, type CardFace } from "./view";

export const EXAMPLE_BREAKDOWN: Breakdown = {
  formula: "v7",
  core: { gh_eng: { weight: 40, value: 82 }, gh_builder: { weight: 20, value: 80 } },
  bonus: { rep: { max: 25, value: 70 }, onchain: { max: 5, value: 91.7 }, x: { max: 5, value: 46.3 } },
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

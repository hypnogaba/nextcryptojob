// Хто може створити картку ролі.
//
// До 13.09 (рішення 12.09) лише з головним джерелом ролі, підтвердженим кодом у біо, а картка
// трейдера мала позначку «Wallets not verified». Власник 13.09 перейшов на довіру: X, GitHub і
// гаманці, які людина вписала сама, рахуються, і картку можна створити для будь-якої ролі з балом.
// Ризик і як скасувати: docs/DECISIONS.md (13.09). Самозаявленість видно тихим рядком на публічній
// сторінці картки, і будь-хто може поскаржитись на картку.
import { isScoredRoleKey } from "@/lib/roles/recipes";
import type { RoleKey } from "./roles";

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** Картка можлива для ролі, яка має бал у релізі 1. Саме значення балу перевіряє той, хто кличе. */
export function cardEligibility(role: RoleKey): Eligibility {
  return isScoredRoleKey(role) ? { ok: true } : { ok: false, reason: "This role has no score yet, so it cannot have a card." };
}

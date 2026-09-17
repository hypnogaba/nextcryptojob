// Поточна формула для рушія. З 17.09.2026 це v7 (formula/v7.ts); v6 лишилась у score-v6.ts для
// звірки з Python-еталоном (scripts/parity.ts).
export {
  FORMULA_VERSION, levelOf, scorePersonV7 as scorePerson,
  type BreakdownV7 as BreakdownJson, type PersonScoreV7 as PersonScore, type RoleResultV7 as RoleResult,
} from "./v7.js";

// Кроки анкети першого входу. Досягнутий крок лежить у users.onboarding_step,
// тож після перезавантаження людина продовжує з того самого місця.
//
// Дві частини. Спершу коротка анкета (brief): що людина шукає своїми словами, ролі,
// віддалено чи місто й зарплата, куди й коли слати вакансії. Остання кнопка анкети приймає
// умови (рядок «By continuing you agree…», без галок: власник 14.09, раунд 3). Після неї
// щоденна добірка вже може йти. Далі кроки балу (рішення власника 13.09): X обов'язковий, без нього
// далі не пускаємо; гаманці (до 10) і інші джерела необов'язкові, кожне піднімає бал. Після них
// /welcome/score ставить бал у чергу, чекає на нього й показує картку.

export const BRIEF_STEPS = ["target", "roles", "place", "delivery"] as const;
export const STANDOUT_STEPS = ["x", "wallets", "sources"] as const;
export const STEPS = [...BRIEF_STEPS, ...STANDOUT_STEPS] as const;
export type Step = (typeof STEPS)[number];
export type BriefStep = (typeof BRIEF_STEPS)[number];
export type StandoutStep = (typeof STANDOUT_STEPS)[number];
/** Що лежить у базі: досягнутий крок або «done», коли пройдено й «Stand out». */
export type SavedStep = Step | "done";

export const STEP_TITLES: Record<Step, string> = {
  target: "What job are you looking for?",
  roles: "Is this your role?",
  place: "Where do you want to work?",
  delivery: "How should we send your jobs?",
  x: "Your X account",
  wallets: "Your wallets",
  sources: "More sources",
};

export function isStep(value: unknown): value is Step {
  return typeof value === "string" && (STEPS as readonly string[]).includes(value);
}

export function isBriefStep(value: unknown): value is BriefStep {
  return typeof value === "string" && (BRIEF_STEPS as readonly string[]).includes(value);
}

export function isStandoutStep(value: unknown): value is StandoutStep {
  return typeof value === "string" && (STANDOUT_STEPS as readonly string[]).includes(value);
}

/**
 * Значення з бази; NULL або щось незнайоме = початок. «consent» (окремий крок згоди до раунду 3)
 * = «delivery»: людина ще не приймала умов, і остання кнопка анкети тепер там.
 */
export function parseSavedStep(value: string | null | undefined): SavedStep {
  if (value === "done") return "done";
  if (value === "consent") return "delivery";
  return isStep(value) ? value : "target";
}

/**
 * Досягнутий крок з урахуванням умов (або старої згоди на бал). До 13.09 кроки X, гаманців і
 * джерел ішли перед згодою; хто зупинився на них за старим порядком, умов ще не приймав. Такого
 * повертаємо на «delivery», де остання кнопка анкети.
 */
export function normalizeSavedStep(saved: SavedStep, scoringBasis: boolean): SavedStep {
  return isStandoutStep(saved) && !scoringBasis ? "delivery" : saved;
}

/** Анкету (brief) пройдено: умови прийнято, вакансії вже можна показувати й слати. */
export function briefDone(saved: SavedStep): boolean {
  return saved === "done" || isStandoutStep(saved);
}

/** Де крок у своїй частині: «Step 2 of 5» для анкети, «2 of 3» для «Stand out». */
export function stepPosition(step: Step): { part: "brief" | "standout"; n: number; of: number } {
  if (isBriefStep(step)) return { part: "brief", n: BRIEF_STEPS.indexOf(step) + 1, of: BRIEF_STEPS.length };
  return { part: "standout", n: STANDOUT_STEPS.indexOf(step as StandoutStep) + 1, of: STANDOUT_STEPS.length };
}

/** Номер кроку для людини в його частині, з 1. */
export function stepNumber(step: Step): number {
  return stepPosition(step).n;
}

export function nextStep(step: Step): SavedStep {
  return STEPS[STEPS.indexOf(step) + 1] ?? "done";
}

/** Попередній крок у тій самій частині; null для першого кроку частини. */
export function prevStep(step: Step): Step | null {
  const part: readonly Step[] = isBriefStep(step) ? BRIEF_STEPS : STANDOUT_STEPS;
  return part[part.indexOf(step) - 1] ?? null;
}

const rank = (s: SavedStep) => (s === "done" ? STEPS.length : STEPS.indexOf(s));

/** Куди можна зайти: будь-який уже пройдений крок, після завершення будь-який. */
export function canVisit(step: Step, saved: SavedStep): boolean {
  return rank(step) <= rank(saved);
}

/** Досягнутий крок після того, як людина пройшла `completed`: лише вперед. */
export function advance(saved: SavedStep, completed: Step): SavedStep {
  const next = nextStep(completed);
  return rank(next) > rank(saved) ? next : saved;
}

/** Який крок показати на /welcome: запитаний, якщо можна, інакше досягнутий. */
export function stepToShow(requested: unknown, saved: SavedStep): Step {
  if (isStep(requested) && canVisit(requested, saved)) return requested;
  return saved === "done" ? "target" : saved;
}

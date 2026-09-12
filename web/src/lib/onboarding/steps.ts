// Кроки анкети першого входу. Досягнутий крок лежить у users.onboarding_step,
// тож після перезавантаження людина продовжує з того самого місця.

export const STEPS = ["target", "roles", "place", "x", "wallets", "sources", "consent"] as const;
export type Step = (typeof STEPS)[number];
/** Що лежить у базі: досягнутий крок або «done», коли анкету завершено. */
export type SavedStep = Step | "done";

export const STEP_TITLES: Record<Step, string> = {
  target: "What job are you looking for?",
  roles: "Pick your roles",
  place: "Where do you want to work?",
  x: "Your X account",
  wallets: "Your wallets",
  sources: "More sources",
  consent: "One last thing",
};

export function isStep(value: unknown): value is Step {
  return typeof value === "string" && (STEPS as readonly string[]).includes(value);
}

/** Значення з бази; NULL або щось незнайоме = початок. */
export function parseSavedStep(value: string | null | undefined): SavedStep {
  if (value === "done") return "done";
  return isStep(value) ? value : "target";
}

/** Номер кроку для людини, з 1. */
export function stepNumber(step: Step): number {
  return STEPS.indexOf(step) + 1;
}

export function nextStep(step: Step): SavedStep {
  return STEPS[STEPS.indexOf(step) + 1] ?? "done";
}

export function prevStep(step: Step): Step | null {
  return STEPS[STEPS.indexOf(step) - 1] ?? null;
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

// Причини скарги на картку («Report this card», модель довіри 13.09). Лише ключі йдуть у журнал.
export const REPORT_REASONS = {
  not_theirs: "This is not their X, GitHub or wallet",
  fake: "The work behind it looks fake",
  other: "Something else is wrong",
} as const;

export type ReportReason = keyof typeof REPORT_REASONS;

export function isReportReason(value: string): value is ReportReason {
  return Object.hasOwn(REPORT_REASONS, value);
}

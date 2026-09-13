import { COMPANY_SWITCHED_TEXT } from "@/lib/crm/company";

/**
 * Тексти відповіді дій, що повертають на сторінку переходом (?done=… або
 * ?error=<код>): воронка, знайомства, збережені пошуки. Код з реєстру дій
 * (types.ts ERROR_CODES) або CompanyError; невідомий код дає загальний текст.
 */

export const ERROR_TEXT: Record<string, string> = {
  invalid_stage_transition: "This card changed in the meantime, or an intro is pending. Reload the page and try again.",
  contact_not_shared: "Contact is not shared yet. Request an intro first.",
  not_found: "It was not found. It may have been removed already.",
  intro_not_pending: "This intro is no longer pending.",
  company_switched: COMPANY_SWITCHED_TEXT,
  subscription_required: "Subscribe to do this in the web app, or use the API.",
  company_not_active: "Your company does not have access yet.",
  forbidden: "Your role in the team cannot do this.",
  validation_failed: "Some fields are not valid. Check them and try again.",
  unauthorized: "Sign in again to continue.",
};

export const DONE_TEXT: Record<string, string> = {
  moved: "Card moved.",
  withdrawn: "Request withdrawn. The card is back in Found.",
  deleted: "Saved search deleted.",
  alert_on: "Daily alert on.",
  alert_off: "Daily alert off.",
};

export function errorText(code: string | undefined): string | null {
  return code ? (ERROR_TEXT[code] ?? "Something went wrong. Try again.") : null;
}

export function doneText(code: string | undefined): string | null {
  return code ? (DONE_TEXT[code] ?? null) : null;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

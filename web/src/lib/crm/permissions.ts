import { ActionError } from "./types";

/**
 * Матриця прав зі специфікації CRM, розділ 2.2. Один рядок таблиці = один
 * рядок тут; «R» (лише читання) розкладено на окреме право читання.
 *
 * Агент = ключ API, створений власником; діє в межах доступу компанії.
 * Адмін не бачить контактів кандидатів через CRM і не входить від імені компанії.
 */

export type ActorRole = "owner" | "member" | "agent" | "x402_guest" | "admin";

export const PERMISSIONS = {
  // Пошук кандидатів: ✓ ✓ ✓ ✓(платно) ·
  "candidates.search": ["owner", "member", "agent", "x402_guest"],
  // Профіль кандидата
  "candidates.view": ["owner", "member", "agent"],
  // Воронка: додати, етап, теги, нотатки, видалити картку; історія картки
  "pipeline.write": ["owner", "member", "agent"],
  "pipeline.read": ["owner", "member", "agent"],
  // Запит на знайомство, скасування (і читання своїх знайомств)
  "intros.write": ["owner", "member", "agent"],
  "intros.read": ["owner", "member", "agent"],
  // Вакансії: створити, змінити, закрити; адмін лише ховає/показує
  "jobs.write": ["owner", "member", "agent"],
  "jobs.read": ["owner", "member", "agent"],
  "jobs.moderate": ["admin"],
  // Черга постів у X
  "x_queue.manage": ["admin"],
  // Збережені пошуки
  "saved_searches.manage": ["owner", "member", "agent"],
  // Вебхук: адреса, ротація, тест (member R)
  "webhook.write": ["owner", "agent"],
  "webhook.read": ["owner", "member", "agent"],
  // Ключі API: створити (лише власник), відкликати (власник, адмін)
  "api_keys.create": ["owner"],
  "api_keys.revoke": ["owner", "admin"],
  "api_keys.read": ["owner"],
  // Команда: запросити, прибрати, змінити роль
  "team.manage": ["owner"],
  // Налаштування компанії (member R, admin лише статус)
  "settings.write": ["owner"],
  "settings.read": ["owner", "member"],
  "company.status": ["admin"],
  // Оплата
  "billing.stripe": ["owner"],
  "billing.usdc": ["owner", "agent"],
  "access.grant": ["admin"],
  // Журнал дій компанії (member R, admin R)
  "audit.read": ["owner", "member", "admin"],
  // Використання (member R, agent R, admin R)
  "usage.read": ["owner", "member", "agent", "admin"],
  // Закрити компанію
  "company.close": ["owner", "admin"],
  // Схвалити заявку агенції, призупинити компанію
  "company.review": ["admin"],
  // Шапка й дашборд: компанія, доступ, квоти (get_account)
  "account.read": ["owner", "member", "agent"],
} as const satisfies Record<string, readonly ActorRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: ActorRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly ActorRole[]).includes(role);
}

/**
 * Право або помилка.
 * - гість x402 там, де потрібна особа компанії → 401 `key_required` (x402 це оплата, не особа);
 * - роль компанії без права (напр. member і ключі API) → 403 `forbidden`.
 *   Такого коду в openapi.yaml немає: через REST і MCP діє лише агент, а в агента
 *   немає заборонених дій серед 28 операцій. Код бачить лише інтерфейс.
 */
export function assertCan(role: ActorRole, permission: Permission): void {
  if (can(role, permission)) return;
  if (role === "x402_guest") {
    throw new ActionError("key_required", 401, "This action needs an API key. x402 payment alone is not enough.");
  }
  throw new ActionError("forbidden", 403, FORBIDDEN_MESSAGES[permission] ?? "Only the company owner can do this.");
}

const FORBIDDEN_MESSAGES: Partial<Record<Permission, string>> = {
  "api_keys.create": "Only the company owner can create API keys.",
  "api_keys.revoke": "Only the company owner can revoke API keys.",
  "team.manage": "Only the company owner can manage the team.",
  "webhook.write": "Only the company owner can change the webhook.",
  "billing.stripe": "Only the company owner can manage billing.",
};

// База вакансій NextCryptoJob з оточення engine: той самий акаунт і токен, що й основна база
// (CF_ACCOUNT_ID, CF_API_TOKEN), своя змінна CF_JOBS_D1_DATABASE_ID. Типового значення немає.
import { D1Client } from "../d1.js";
import type { EngineEnv } from "../pipeline/registry.js";

export const JOBS_DB_ENV = "CF_JOBS_D1_DATABASE_ID";

/**
 * Бази, куди сканер писати не має права ніколи. До 14.09.2026 сайт і добірка читали вакансії з
 * бази NextRole (D1 `crypto-jobs-agent`); тепер у NextCryptoJob своя база, а стара змінна
 * JOBS_D1_DATABASE_ID могла лишитися в /etc/nextcryptojob-engine.env. Сканер пише, тож помилка
 * в id зіпсувала б чужий продукт: такий id відкидаємо з поясненням, а не пробуємо.
 */
const FOREIGN_DATABASES: Record<string, string> = {
  "0bf4b998-cbdc-474b-b739-eb6e6e7d5a9d": "the NextRole job cache (crypto-jobs-agent)",
};

/** id бази вакансій або ясна помилка з назвою змінної. */
export function jobsDatabaseId(env: EngineEnv): string {
  const id = env[JOBS_DB_ENV]?.trim();
  if (!id) {
    throw new Error(`немає ${JOBS_DB_ENV}: id бази вакансій nextcryptojob-jobs (див. engine/deploy/README.md, /etc/nextcryptojob-engine.env)`);
  }
  const foreign = FOREIGN_DATABASES[id.toLowerCase()];
  if (foreign) throw new Error(`${JOBS_DB_ENV} вказує на ${foreign}; NextCryptoJob має власну базу вакансій nextcryptojob-jobs`);
  if (id === env.CF_D1_DATABASE_ID?.trim()) {
    throw new Error(`${JOBS_DB_ENV} збігається з CF_D1_DATABASE_ID: база вакансій окрема від основної`);
  }
  return id;
}

/** Клієнт D1 бази вакансій. Без облікових даних ясна помилка з назвами змінних. */
export function jobsD1FromEnv(env: EngineEnv): D1Client {
  const missing = ["CF_ACCOUNT_ID", "CF_API_TOKEN"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`немає змінних оточення для бази вакансій: ${missing.join(", ")} (див. /etc/nextcryptojob-engine.env)`);
  }
  return new D1Client({ accountId: env.CF_ACCOUNT_ID!, databaseId: jobsDatabaseId(env), token: env.CF_API_TOKEN! });
}

/** Число з оточення з межами; погане значення = ясна помилка, а не мовчазний типовий. */
export function envInt(env: EngineEnv, name: string, fallback: number, min = 1, max = 3650): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} має бути цілим від ${min} до ${max}, а не «${raw}»`);
  return n;
}

/** Прапорець з оточення: лише '1' вмикає, лише '0' вимикає; решта = типовий. */
export function envFlag(env: EngineEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}

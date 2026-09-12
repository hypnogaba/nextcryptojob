import type { DatabaseSync } from "node:sqlite";
import type { AppEnv } from "@/lib/db";
import { migratedD1 } from "./sqlite-d1";

/**
 * Замінники для модулів, яких поза Worker і Next немає: оточення Cloudflare,
 * куки й заголовки запиту, redirect. Тест підключає їх так:
 *
 *   vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
 *   vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
 *   vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);
 *
 * і викликає resetHarness() перед кожним тестом.
 */

export const TEST_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";

type StoredCookie = { value: string; options: Record<string, unknown> };

export function fakeCookieJar() {
  const store = new Map<string, StoredCookie>();
  return {
    store,
    get(name: string) {
      const c = store.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    set(name: string, value: string, options: Record<string, unknown> = {}) {
      store.set(name, { value, options });
    },
    delete(name: string) {
      store.delete(name);
    },
  };
}

export const harness = {
  raw: null as unknown as DatabaseSync,
  env: {} as AppEnv,
  jar: fakeCookieJar(),
  headers: new Headers(),
};

export function resetHarness(env: Partial<AppEnv> = {}): void {
  const { raw, d1 } = migratedD1();
  harness.raw = raw;
  harness.env = { DB: d1, SESSION_SECRET: TEST_SECRET, ...env } as AppEnv;
  harness.jar = fakeCookieJar();
  harness.headers = new Headers();
}

export class RedirectCalled extends Error {
  constructor(readonly url: string) {
    super(`redirect(${url})`);
  }
}

export const cloudflareModule = {
  getCloudflareContext: () => ({ env: harness.env, cf: {}, ctx: {} }),
};

export const headersModule = {
  cookies: async () => harness.jar,
  headers: async () => harness.headers,
};

export const navigationModule = {
  redirect: (url: string): never => {
    throw new RedirectCalled(url);
  },
};

/** Рядки таблиці як прості об'єкти. */
export function rows<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
  return harness.raw.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
}

export function exec(sql: string, ...params: (string | number | null)[]): void {
  harness.raw.prepare(sql).run(...params);
}

import { appEnv, db } from "@/lib/db";
import { digestEmailResponse } from "@/lib/digest/email";

/**
 * Лист щоденної добірки: кличе лише engine, запит підписано INTERNAL_API_SECRET.
 * Контракт: engine/src/digest/README.md. Уся логіка й коди відповіді в lib/digest/email.ts.
 */
export async function POST(request: Request): Promise<Response> {
  return digestEmailResponse(request, { db: db(), env: appEnv() });
}

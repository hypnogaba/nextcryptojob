import { telegramEnv } from "@/lib/telegram/env";
import { handleWebhookRequest } from "@/lib/telegram/webhook";

/** Вебхук @nextcryptojob_bot. Уся логіка й захист у src/lib/telegram/webhook.ts. */
export async function POST(request: Request) {
  return handleWebhookRequest(request, telegramEnv());
}

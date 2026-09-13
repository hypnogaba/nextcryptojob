"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";
import { createApiKey, revokeApiKey } from "@/lib/crm/keys";
import { ActionError, type Webhook } from "@/lib/crm/types";
import type { SendResult } from "@/lib/crm/webhooks";
import { isId } from "@/lib/ids";

/**
 * Дії сторінки Developers (специфікація 10.2, W6): ключі API і вебхук.
 * Актор із сесії (crmActionActor: RL_WEB), прихований id компанії порівнюється з
 * компанією сесії (assertFormCompany). Вебхук іде через реєстр дій (set_webhook,
 * test_webhook), тож права й доступ ті самі, що в REST і MCP.
 *
 * Ключ і секрет вебхука повертаються лише в стані цієї відповіді (useActionState):
 * у базі їх немає, сторінка після перезавантаження їх не покаже.
 */

const PAGE = "/company/developers";

export type CreateKeyState = {
  message?: FormMessage;
  errors?: { name?: string };
  /** Щойно створений ключ: показати один раз. */
  created?: { name: string; key: string };
};

export async function createKeyAction(_prev: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const name = String(form.get("name") ?? "");
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    const created = await createApiKey(ctx, name);
    revalidatePath(PAGE);
    return { created: { name: created.name, key: created.key }, message: { tone: "success", text: "Key created." } };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { errors: known.fields as CreateKeyState["errors"], message: { tone: "error", text: known.fields?.name ?? known.message } };
  }
}

export async function revokeKeyAction(form: FormData): Promise<void> {
  const keyId = form.get("key_id");
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    if (!isId("key", keyId)) throw new ActionError("not_found", 404, "This API key does not exist or is already revoked.");
    await revokeApiKey(ctx, keyId);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`${PAGE}?error=${encodeURIComponent(known.code)}#keys`);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?done=revoked#keys`);
}

export type WebhookState = {
  message?: FormMessage;
  errors?: { url?: string };
  /** Секрет після першого URL чи ротації: показати один раз. */
  secret?: string;
  /** Відповідь приймача на тестовий ping. */
  test?: SendResult;
  /** Що ввели в поле (щоб не губити текст після помилки). */
  url?: string;
};

/** Одна форма вебхука, три кнопки: intent = save | rotate | test. */
export async function webhookAction(_prev: WebhookState, form: FormData): Promise<WebhookState> {
  const intent = String(form.get("intent") ?? "save");
  const url = String(form.get("url") ?? "").trim();
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    if (intent === "test") {
      const { output } = await runAction("test_webhook", {}, ctx);
      const test = output as SendResult;
      return {
        test,
        message: test.delivered
          ? { tone: "success", text: `Test delivered: HTTP ${test.status_code} in ${test.duration_ms} ms.` }
          : { tone: "error", text: `Test failed: ${test.error ?? "no answer"}.` },
      };
    }
    let input: Record<string, unknown>;
    if (intent === "rotate") {
      input = { rotate_secret: true };
    } else {
      if (!url) return { url, errors: { url: "Enter the https:// URL of your endpoint." }, message: { tone: "error", text: "Check the URL." } };
      input = { url, enabled: form.get("enabled") === "on" };
    }
    const { output } = await runAction("set_webhook", input, ctx);
    const hook = output as Webhook;
    revalidatePath(PAGE);
    return {
      secret: hook.secret ?? undefined,
      message: {
        tone: "success",
        text: intent === "rotate" ? "Secret rotated. We sign with both secrets for 24 hours." : hook.enabled ? "Saved. The webhook is on." : "Saved. The webhook is off.",
      },
    };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    const text =
      known.code === "not_configured"
        ? "Webhooks are not available yet. Your agent can poll list_intros with updated_since."
        : (known.fields?.url ?? known.message);
    return { url, errors: known.fields?.url ? { url: known.fields.url } : undefined, message: { tone: "error", text } };
  }
}

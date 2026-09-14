"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { eraseAccount } from "@/lib/account/erase";
import {
  detectTimezone,
  loadSettings,
  saveDailyJobs,
  setContactMode,
  setVisibility,
  validateDailyJobs,
} from "@/lib/account/settings";
import { audit } from "@/lib/audit";
import { consume, type Limits } from "@/lib/auth/ratelimit";
import { requireUser, signOut } from "@/lib/auth/session";
import { CONTACT_CONSENT, VISIBILITY_CONSENT } from "@/lib/consent";
import { db } from "@/lib/db";

export type SettingsState = { message?: FormMessage; errors?: Record<string, string> };

const GENERIC: FormMessage = { tone: "error", text: "Something went wrong. Try again." };

/**
 * 60 змін згод на годину: кожне перемикання пише подію в незмінну історію,
 * тож скрипт не має роздувати її без меж.
 */
const CONSENT_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 60, blockMinutes: 60 };

async function consentGuard(d: D1Database, userId: string): Promise<FormMessage | null> {
  const verdict = await consume(`settings:${userId}`, CONSENT_LIMITS, d);
  if (verdict.allowed) return null;
  return { tone: "error", text: `Too many changes. Try again in ${verdict.retryAfterMinutes} minutes.` };
}

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

/** «Daily jobs»: канал, година, пояс, пауза. */
export async function saveDailyJobsAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const user = await requireUser();
  const d = db();
  const settings = await loadSettings(d, user.id);
  if (!settings) redirect("/login");
  const res = validateDailyJobs(
    { channel: text(form, "channel"), hour: text(form, "hour"), timezone: text(form, "timezone"), paused: text(form, "paused") },
    { email: settings.email !== null, telegram: settings.telegramLinked },
  );
  if (!res.ok) return { errors: res.errors, message: { tone: "error", text: "Check the fields above." } };
  await saveDailyJobs(d, user.id, res.value);
  revalidatePath("/settings");
  return {
    message: {
      tone: "success",
      text: res.value.paused ? "Saved. Daily jobs are paused." : "Saved.",
    },
  };
}

/** Пояс із браузера при першому візиті; мовчки, без повідомлень. */
export async function detectTimezoneAction(timezone: string): Promise<void> {
  const user = await requireUser();
  await detectTimezone(db(), user.id, timezone);
}

/** «Show me to companies». */
export async function setVisibilityAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const user = await requireUser();
  const d = db();
  const on = text(form, "visible") === "on";
  const limited = await consentGuard(d, user.id);
  if (limited) return { message: limited };
  let res;
  try {
    res = await setVisibility(d, user.id, on);
  } catch (err) {
    console.error("setVisibility failed:", err instanceof Error ? err.message : String(err));
    return { message: GENERIC };
  }
  if (!res.ok) {
    if (res.reason === "no_user") redirect("/login");
    return { message: { tone: "error", text: "Finish setup first. Companies can only see you once you have a score." } };
  }
  if (res.changed) {
    await audit(user.id, on ? "consent.grant" : "consent.revoke", user.id, {
      kind: VISIBILITY_CONSENT.kind,
      version: VISIBILITY_CONSENT.version,
    });
  }
  revalidatePath("/settings");
  return {
    message: on
      ? { tone: "success", text: "Saved. You are visible: companies with access can now find you." }
      : { tone: "success", text: "Saved. You are hidden: companies cannot find you." },
  };
}

/** «Show my Telegram directly»: увімкнути або повернутися до «after approval». */
export async function setContactModeAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const user = await requireUser();
  const d = db();
  const mode = text(form, "mode");
  const limited = await consentGuard(d, user.id);
  if (limited) return { message: limited };
  let res;
  try {
    res = await setContactMode(d, user.id, mode);
  } catch (err) {
    console.error("setContactMode failed:", err instanceof Error ? err.message : String(err));
    return { message: GENERIC };
  }
  if (!res.ok) {
    if (res.reason === "no_user") redirect("/login");
    return { errors: { mode: "Choose one option." } };
  }
  if (res.changed && (mode === "direct" || res.from === "direct")) {
    await audit(user.id, mode === "direct" ? "consent.grant" : "consent.revoke", user.id, {
      kind: CONTACT_CONSENT.kind,
      version: CONTACT_CONSENT.version,
    });
  }
  revalidatePath("/settings");
  if (mode === "direct") {
    const settings = await loadSettings(d, user.id);
    return {
      message: {
        tone: "success",
        text: settings?.telegramHandle?.trim()
          ? "Saved. Companies that can see you also see your Telegram handle."
          : "Saved. Companies will see your Telegram once you set a username in Telegram. Until then they ask you first.",
      },
    };
  }
  return {
    message: {
      tone: "success",
      text:
        res.changed && res.from === "direct"
          ? "Saved. Companies must ask you first. Companies that already saw your handle keep it under their own responsibility. They may use it only for recruiting."
          : "Saved. Companies must ask you first.",
    },
  };
}

/** «Delete my account»: лише після слова DELETE; потім вихід. */
export async function deleteAccountAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const user = await requireUser();
  if (text(form, "confirm").trim() !== "DELETE") {
    return { errors: { confirm: "Type DELETE in capital letters to confirm." } };
  }
  let res;
  try {
    res = await eraseAccount(db(), user.id);
  } catch (err) {
    console.error("eraseAccount failed:", err instanceof Error ? err.message : String(err));
    return { message: { tone: "error", text: "We could not delete your account. Nothing was deleted. Try again." } };
  }
  if (!res.ok && res.reason === "blocked") {
    return { message: { tone: "error", text: res.message ?? "Your account cannot be deleted right now." } };
  }
  // Сесії вже зникли каскадом; signOut прибирає куку.
  await signOut();
  redirect("/");
}

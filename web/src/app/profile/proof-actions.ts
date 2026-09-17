"use server";

import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/session";
import { addLink, ensureKeyVersion, isItemId, removeLink, resetKey, setHidden, setShowWallet } from "@/lib/card/profile-prefs";
import { db } from "@/lib/db";
import { enqueueScoreJob } from "@/lib/score/queue";

// Керування профілем-доказом (docs/specs/2026-09-16-proof-profile-design.md, розділ 2).
// Лише свої налаштування: user_id з сесії, не з форми. У журнал ні ключ, ні адреси, ні посилання.

const BACK = "/profile#proof";

export async function toggleProofItemAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const item = String(form.get("item") ?? "");
  const hide = form.get("hide") === "1";
  if (isItemId(item) && (await setHidden(db(), user.id, item, hide))) {
    await audit(user.id, hide ? "profile.hide" : "profile.show", null, { item });
  }
  redirect(BACK);
}

export async function setProofWalletAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const on = form.get("on") === "1";
  await setShowWallet(db(), user.id, on);
  await audit(user.id, "profile.wallets", null, { on });
  redirect(BACK);
}

export type LinkState = { message?: FormMessage; label?: string; url?: string };

export async function addProofLinkAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  const user = await requireUser();
  const label = String(form.get("label") ?? "");
  const url = String(form.get("url") ?? "");
  const res = await addLink(db(), user.id, label, url);
  if (!res.ok) return { message: { tone: "error", text: res.error }, label, url };
  await audit(user.id, "profile.link_add", null);
  // v7: посилання рахуються в балі. Рушій читає їх, коли бере завдання, тож кілька посилань поспіль
  // покриває одне завдання (правило 60 секунд і «вже в черзі» лишаються).
  await enqueueScoreJob(db(), user.id, "manual");
  redirect(BACK);
}

export async function removeProofLinkAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await removeLink(db(), user.id, Number(form.get("index")));
  await audit(user.id, "profile.link_remove", null);
  await enqueueScoreJob(db(), user.id, "manual");
  redirect(BACK);
}

export async function createApplyLinkAction(): Promise<void> {
  const user = await requireUser();
  await ensureKeyVersion(db(), user.id);
  await audit(user.id, "profile.key_create", null);
  redirect(BACK);
}

export async function resetApplyLinkAction(): Promise<void> {
  const user = await requireUser();
  const version = await resetKey(db(), user.id);
  await audit(user.id, "profile.key_reset", null, { version });
  redirect(BACK);
}

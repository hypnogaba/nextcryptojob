"use server";

import { redirect } from "next/navigation";
import { SETTINGS, updateSettings, type SettingKey } from "@/lib/admin/settings";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";

/**
 * Зміна налаштувань з /admin/settings. Server action це публічна кінцева точка, тож дія
 * сама перевіряє адміна. Форма шле групу ключів (прихований `keys`); перемикач без
 * позначки не приходить у FormData, тож відсутнє поле булевого ключа = «вимкнено».
 * Результат іде в адресу: ?done=saved&changed=… або ?error=<ключ>.
 */

const PAGE = "/admin/settings";

export type SettingsError = "not_admin" | "unavailable" | SettingKey;

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

export async function saveSettingsAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");

  const keys = String(form.get("keys") ?? "")
    .split(",")
    .filter((k): k is SettingKey => Object.hasOwn(SETTINGS, k));
  const values: Partial<Record<SettingKey, unknown>> = {};
  for (const key of keys) {
    const raw = form.get(key);
    values[key] = SETTINGS[key].kind === "boolean" ? raw === "on" || raw === "true" : typeof raw === "string" ? raw : null;
  }

  const res = await updateSettings(db(), { adminUserId: admin.id, values });
  if (!res.ok) {
    if ("unavailable" in res) back("error=unavailable");
    back(`error=${Object.keys(res.errors)[0]}`);
  }
  back(`done=saved&changed=${res.changed.length}`);
}

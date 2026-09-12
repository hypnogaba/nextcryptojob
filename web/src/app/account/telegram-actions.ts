"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isChannel, setChannel } from "@/lib/telegram/channel";

/** Перемикач «Use Telegram for daily jobs» у кабінеті. */
export async function setChannelAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const channel = form.get("channel");
  if (!isChannel(channel)) return;
  const result = await setChannel(db(), user.id, channel);
  if (result === "changed") await audit(user.id, "account.channel_set", user.id, { channel });
  revalidatePath("/account");
}

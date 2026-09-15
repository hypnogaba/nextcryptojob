"use server";

import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { setContactAnswered } from "@/lib/contact";
import { db } from "@/lib/db";

const PAGE = "/admin/messages";

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

/** «Mark answered» / «Mark unanswered» у /admin/messages. */
export async function setAnsweredAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const id = String(form.get("id") ?? "");
  const answered = form.get("answered") === "1";
  const res = await setContactAnswered(db(), id, answered);
  if (!res.ok) back("error=not_found");
  back(`done=${answered ? "answered" : "reopened"}`);
}

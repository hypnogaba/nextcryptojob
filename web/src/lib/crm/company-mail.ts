import type { Mailer, MailMessage } from "@/lib/mail";

/**
 * Листи компаніям: запрошення в команду (6.3) і рішення щодо заявки агенції (6.2).
 * Простий текст англійською, без довгого тире. Назва компанії й нотатки адміна
 * це чужий текст, тож у HTML їх екрановано.
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

type Letter = Omit<MailMessage, "to">;

function letter(subject: string, paragraphs: string[], button?: { label: string; url: string }): Letter {
  const text = [...paragraphs, ...(button ? [`${button.label}: ${button.url}`] : [])].join("\n\n") + "\n";
  const html =
    paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("") +
    (button
      ? `<p><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;` +
        `background:#0b6e63;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`
      : "");
  return { subject, text, html };
}

export function inviteEmail(o: { inviter: string; company: string; link: string; expiresAt: Date }): Letter {
  return letter(
    `${o.inviter} invited you to ${o.company} on NextCryptoJob`,
    [
      `${o.inviter} invited you to join ${o.company} on NextCryptoJob, where companies find crypto candidates by what they have shipped.`,
      `Sign in with this email address to accept. The invite expires on ${DATE.format(o.expiresAt)}.`,
      "If you did not expect this, ignore this email.",
    ],
    { label: "Accept the invite", url: o.link },
  );
}

export function agencyApprovedEmail(o: { company: string; link: string }): Letter {
  return letter(
    "Your agency account is approved",
    [
      `Your agency account ${o.company} on NextCryptoJob is approved.`,
      "You can now search candidates, build your pipeline and request intros. Choose how to pay to get started.",
    ],
    { label: "Open NextCryptoJob", url: o.link },
  );
}

export function agencyNeedsInfoEmail(o: { company: string; note: string; link: string }): Letter {
  return letter(
    "We need more information about your agency",
    [`Thanks for applying with ${o.company}. Before we decide, we need a bit more information:`, o.note, "Update your application and we will review it again."],
    { label: "Update the application", url: o.link },
  );
}

export function agencyRejectedEmail(o: { company: string; reason: string }): Letter {
  return letter("Your agency application was not approved", [
    `We reviewed the application from ${o.company} and cannot approve it.`,
    `Reason: ${o.reason}`,
    "If you think this is a mistake, reply to support@nextcryptojob.xyz.",
  ]);
}

/**
 * Надіслати листи кожному адресату. Пошти немає (продакшн до підключення домену)
 * або вона відмовила: false, і той, хто кликав, показує посилання сам.
 */
export async function sendAll(mailer: Mailer | null, to: readonly string[], message: Letter): Promise<boolean> {
  if (!mailer || to.length === 0) return false;
  let ok = true;
  for (const address of to) {
    try {
      await mailer.send({ to: address, ...message });
    } catch (err) {
      ok = false;
      console.error("company mail failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return ok;
}

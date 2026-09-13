import { hourLabel } from "@/lib/digest/format";
import type { DigestSetup } from "@/lib/digest/history";
import { type NoMatchReason, roleList, roughCount } from "@/lib/jobs/instant";

/**
 * Чому на /jobs порожньо, словами людини, і куди йти далі. Порядок той, у якому
 * engine пропускає людину: пауза, нема куди слати, немає ролей; далі стан
 * останньої добірки.
 */

export type EmptyState = { title: string; body: string; href: string; cta: string };

/** «07:00 (America/New York)». */
export function whenLabel(setup: Pick<DigestSetup, "hour" | "timezone">): string {
  return `${hourLabel(setup.hour)} (${setup.timezone.replace(/_/g, " ")})`;
}

const BY = { email: "by email", telegram: "in Telegram" } as const;

export function emptyState(setup: DigestSetup): EmptyState {
  const when = whenLabel(setup);
  const settings = { href: "/settings", cta: "Open settings" };
  if (setup.paused) {
    return { title: "Daily jobs are paused.", body: `Turn them back on in settings. Then they come every day at ${when}.`, ...settings };
  }
  if (!setup.channel) {
    return {
      title: "We have nowhere to send your jobs yet.",
      body: "Add an email or connect Telegram in settings.",
      ...settings,
    };
  }
  if (!setup.hasRoles) {
    return {
      title: "Pick your roles first.",
      body: "We match jobs to the roles you choose.",
      href: "/welcome",
      cta: "Finish setting up",
    };
  }
  const by = BY[setup.channel];
  switch (setup.lastRun) {
    case "empty":
      return {
        title: "No jobs matched your roles yet.",
        body: `We look again every day at ${when} and send new matches ${by}.`,
        ...settings,
      };
    case "failed":
      return {
        title: "We could not deliver your last jobs.",
        body: `Check your email or Telegram in settings. We try again at ${when}.`,
        ...settings,
      };
    case "pending":
      return { title: "Your jobs are on their way.", body: `They go out ${by} in a few minutes.`, ...settings };
    case "sent":
      return {
        title: "No jobs in the last 14 days.",
        body: `Your next jobs come at ${when}, ${by}.`,
        ...settings,
      };
    default:
      return {
        title: "Your first jobs are coming.",
        body: `Up to 5 jobs that match your roles, every day at ${when}, ${by}.`,
        ...settings,
      };
  }
}

/** Рядок над списком, коли вакансії вже є. */
export function scheduleLine(setup: DigestSetup): string {
  if (setup.paused) return "Daily jobs are paused. Jobs we sent before stay here.";
  if (!setup.channel) return "We have nowhere to send new jobs. Add an email or connect Telegram.";
  return `Up to 5 jobs a day at ${whenLabel(setup)}, ${BY[setup.channel]}. Here are the last 14 days.`;
}

/** Місто, як його ввела людина, без країни після коми (як cityLabel в engine). */
const cityLabel = (city: string): string => (city.split(",")[0] ?? city).trim();

/** «1 job for your roles is», «1,900+ jobs for your roles are». */
const jobsAre = (n: number) => `${roughCount(n)} job${n === 1 ? "" : "s"} for your roles ${n === 1 ? "is" : "are"}`;

/**
 * «Jobs for you now» порожній: чому, і що змінити в анкеті. Зарплата вакансій не
 * відсіює (правило м'яке), тож причина завжди роль, місце або «усе вже надіслано».
 */
export function noMatch(reason: NoMatchReason): EmptyState {
  const place = { href: "/welcome?step=place", cta: "Change where you work" };
  switch (reason.kind) {
    case "no_roles":
      return { title: "Pick your roles first.", body: "We match jobs to the roles you choose.", href: "/welcome", cta: "Finish your brief" };
    case "no_role_jobs":
      return {
        title: `No live ${roleList(reason.roles)} jobs right now.`,
        body: "New jobs come in every day. Another role widens the search.",
        href: "/welcome?step=roles",
        cta: "Change your roles",
      };
    case "city_only": {
      const city = cityLabel(reason.city);
      return reason.remote > 0
        ? {
            title: `Nothing in ${city} right now.`,
            body: `${jobsAre(reason.remote)} remote. Add remote work to see them.`,
            ...place,
          }
        : {
            title: `Nothing in ${city} right now.`,
            body: "Jobs for your roles are in other cities today. Try a bigger city nearby or add remote work.",
            ...place,
          };
    }
    case "remote_only":
      return {
        title: "No remote jobs for your roles right now.",
        body:
          reason.inCities > 0
            ? `${jobsAre(reason.inCities)} in a city. Add your city to see them.`
            : "New jobs come in every day. Adding a city widens the search.",
        ...place,
      };
    case "all_sent":
      return {
        title: "You have seen every match for now.",
        body: "New jobs come in every day. We send the next ones with your daily list.",
        href: "/welcome?step=roles",
        cta: "Change your roles",
      };
  }
}

import { describe, expect, it } from "vitest";
import type { DigestSetup } from "@/lib/digest/history";
import { emptyState, noMatch, scheduleLine } from "./empty-state";

const base: DigestSetup = { paused: false, channel: "email", hasRoles: true, hour: 7, timezone: "America/New_York", lastRun: null };

describe("emptyState says why there are no jobs", () => {
  it("names the pause first, even when something else is missing too", () => {
    expect(emptyState({ ...base, paused: true, channel: null, hasRoles: false })).toEqual({
      title: "Daily jobs are paused.",
      body: "Turn them back on in settings. Then they come every day at 07:00 (America/New York).",
      href: "/settings",
      cta: "Open settings",
    });
  });

  it("then a missing channel, then missing roles", () => {
    expect(emptyState({ ...base, channel: null, hasRoles: false })).toMatchObject({
      title: "We have nowhere to send your jobs yet.",
      href: "/settings",
    });
    expect(emptyState({ ...base, hasRoles: false })).toMatchObject({ title: "Pick your roles first.", href: "/welcome" });
  });

  it("before the first digest, tells when and where it comes", () => {
    expect(emptyState({ ...base, channel: "telegram", hour: 18 })).toMatchObject({
      title: "Your first jobs are coming.",
      body: "Up to 5 jobs that match your roles, every day at 18:00 (America/New York), in Telegram.",
      href: "/settings",
    });
  });

  it("after a digest with no matches or a failed one, says so", () => {
    expect(emptyState({ ...base, lastRun: "empty" }).title).toBe("No jobs matched your roles yet.");
    expect(emptyState({ ...base, lastRun: "failed" }).title).toBe("We could not deliver your last jobs.");
    expect(emptyState({ ...base, lastRun: "sent" }).title).toBe("No jobs in the last 14 days.");
  });
});

describe("scheduleLine", () => {
  it("tells the hour and the channel, or that the digest is paused", () => {
    expect(scheduleLine(base)).toBe("Up to 5 jobs a day at 07:00 (America/New York), by email. Here are the last 14 days.");
    expect(scheduleLine({ ...base, paused: true })).toBe("Daily jobs are paused. Jobs we sent before stay here.");
  });
});

describe("noMatch says why Jobs for you now is empty and what to change", () => {
  it("names the roles when nothing is live for them", () => {
    expect(noMatch({ kind: "no_role_jobs", roles: ["legal_compliance", "hr_recruiting"] })).toEqual({
      title: "No live Legal & compliance or HR & recruiting jobs right now.",
      body: "New jobs come in every day. Another role widens the search.",
      href: "/welcome?step=roles",
      cta: "Change your roles",
    });
  });

  it("a city that is too narrow: counts the remote ones, without the country", () => {
    expect(noMatch({ kind: "city_only", city: "Porto, Portugal", remote: 1909 })).toEqual({
      title: "Nothing in Porto right now.",
      body: "1,900+ jobs for your roles are remote. Add remote work to see them.",
      href: "/welcome?step=place",
      cta: "Change where you work",
    });
    expect(noMatch({ kind: "city_only", city: "Porto", remote: 0 }).body).toContain("in other cities today");
  });

  it("remote only with nothing remote, everything already sent, and no roles", () => {
    expect(noMatch({ kind: "remote_only", inCities: 1 }).body).toBe("1 job for your roles is in a city. Add your city to see them.");
    expect(noMatch({ kind: "all_sent" }).title).toBe("You have seen every match for now.");
    expect(noMatch({ kind: "no_roles" })).toMatchObject({ title: "Pick your roles first.", href: "/welcome" });
  });
});

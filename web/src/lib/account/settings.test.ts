import { beforeEach, describe, expect, it, vi } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import {
  acceptTerms,
  detectTimezone,
  loadSettings,
  saveDailyJobs,
  setContactMode,
  setVisibility,
  validateDailyJobs,
} from "./settings";

const hooks = vi.hoisted(() => ({ notifyCrmVisibility: vi.fn(async () => {}) }));
vi.mock("./hooks", () => hooks);

let t: TestDb;
const all = (sql: string, ...p: (string | number)[]) => t.raw.prepare(sql).all(...p).map((r) => ({ ...r }));
const one = (sql: string, ...p: (string | number)[]) => all(sql, ...p)[0];

function scoringConsent() {
  t.raw.exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1')");
}

beforeEach(() => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com')");
  hooks.notifyCrmVisibility.mockClear();
});

describe("setVisibility", () => {
  it("is off by default", async () => {
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ visible: false, contactMode: "approval" });
  });

  it("turning on writes the consent, its event and the flag in one batch", async () => {
    scoringConsent();
    const batch = vi.spyOn(t.d1, "batch");
    await expect(setVisibility(t.d1, "a", true)).resolves.toEqual({ ok: true, changed: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
    expect(one("SELECT visible_to_companies AS v FROM users")).toEqual({ v: 1 });
    expect(all("SELECT kind, granted, text_version FROM consents WHERE kind = 'visibility'")).toEqual([
      { kind: "visibility", granted: 1, text_version: "v1" },
    ]);
    expect(all("SELECT kind, granted, text_version FROM consent_events")).toEqual([
      { kind: "visibility", granted: 1, text_version: "v1" },
    ]);
    expect(hooks.notifyCrmVisibility).toHaveBeenCalledWith("a", true);
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ visible: true });
  });

  it("turning off clears the flag and appends a revoke event in one batch", async () => {
    scoringConsent();
    await setVisibility(t.d1, "a", true);
    const batch = vi.spyOn(t.d1, "batch");
    await expect(setVisibility(t.d1, "a", false)).resolves.toEqual({ ok: true, changed: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(one("SELECT visible_to_companies AS v FROM users")).toEqual({ v: 0 });
    expect(all("SELECT granted FROM consents WHERE kind = 'visibility'")).toEqual([{ granted: 0 }]);
    expect(all("SELECT granted FROM consent_events ORDER BY id")).toEqual([{ granted: 1 }, { granted: 0 }]);
    expect(hooks.notifyCrmVisibility).toHaveBeenLastCalledWith("a", false);
  });

  it("does nothing when the state does not change", async () => {
    await expect(setVisibility(t.d1, "a", false)).resolves.toEqual({ ok: true, changed: false });
    scoringConsent();
    await setVisibility(t.d1, "a", true);
    await expect(setVisibility(t.d1, "a", true)).resolves.toEqual({ ok: true, changed: false });
    expect(all("SELECT id FROM consent_events")).toHaveLength(1);
    expect(hooks.notifyCrmVisibility).toHaveBeenCalledTimes(1);
  });

  it("refuses without a scoring consent: no score, nothing to show", async () => {
    await expect(setVisibility(t.d1, "a", true)).resolves.toEqual({ ok: false, reason: "no_scoring_consent" });
    expect(one("SELECT visible_to_companies AS v FROM users")).toEqual({ v: 0 });
    expect(all("SELECT * FROM consent_events")).toEqual([]);
    expect(hooks.notifyCrmVisibility).not.toHaveBeenCalled();
  });

  it("changes nothing at all when one write fails", async () => {
    scoringConsent();
    t.raw.exec("DROP TABLE consent_events");
    await expect(setVisibility(t.d1, "a", true)).rejects.toThrow();
    expect(one("SELECT visible_to_companies AS v FROM users")).toEqual({ v: 0 });
    expect(all("SELECT * FROM consents WHERE kind = 'visibility'")).toEqual([]);
    expect(hooks.notifyCrmVisibility).not.toHaveBeenCalled();
  });

  it("treats the flag without a consent as hidden (CRM rule needs both)", async () => {
    t.raw.exec("UPDATE users SET visible_to_companies = 1");
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ visible: false });
  });
});

describe("setContactMode", () => {
  it("'direct' without a Telegram username is kept: the mode waits for a handle", async () => {
    await expect(setContactMode(t.d1, "a", "direct")).resolves.toEqual({ ok: true, changed: true, from: "approval" });
    expect(one("SELECT contact_mode FROM users")).toEqual({ contact_mode: "direct" });
    expect(all("SELECT kind, granted FROM consents")).toEqual([{ kind: "contact", granted: 1 }]);
    await expect(setContactMode(t.d1, "a", "direct")).resolves.toEqual({ ok: true, changed: false, from: "direct" });
  });

  it("'direct' with Telegram writes the contact consent; back to approval revokes it", async () => {
    t.raw.exec("UPDATE users SET telegram_id = '42', telegram_username = 'ada'");
    const batch = vi.spyOn(t.d1, "batch");
    await expect(setContactMode(t.d1, "a", "direct")).resolves.toEqual({ ok: true, changed: true, from: "approval" });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(one("SELECT contact_mode FROM users")).toEqual({ contact_mode: "direct" });
    expect(all("SELECT kind, granted, text_version FROM consents")).toEqual([
      { kind: "contact", granted: 1, text_version: "v1" },
    ]);

    await expect(setContactMode(t.d1, "a", "approval")).resolves.toEqual({ ok: true, changed: true, from: "direct" });
    expect(one("SELECT contact_mode FROM users")).toEqual({ contact_mode: "approval" });
    expect(all("SELECT granted FROM consents WHERE kind = 'contact'")).toEqual([{ granted: 0 }]);
    expect(all("SELECT kind, granted FROM consent_events ORDER BY id")).toEqual([
      { kind: "contact", granted: 1 },
      { kind: "contact", granted: 0 },
    ]);
  });

  it("rejects unknown modes and keeps 'approval' without writing", async () => {
    await expect(setContactMode(t.d1, "a", "public")).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(setContactMode(t.d1, "a", "approval")).resolves.toEqual({ ok: true, changed: false, from: "approval" });
    expect(all("SELECT * FROM consent_events")).toEqual([]);
  });
});

describe("validateDailyJobs", () => {
  const can = { email: true, telegram: false };
  const base = { channel: "email", hour: "7", timezone: "Europe/Paris", paused: "" };

  it("accepts a full valid form", () => {
    expect(validateDailyJobs(base, can)).toEqual({
      ok: true,
      value: { channel: "email", hour: 7, timezone: "Europe/Paris", paused: false },
    });
  });

  it.each(["0", "23"])("accepts the edge hour %s", (hour) => {
    expect(validateDailyJobs({ ...base, hour }, can)).toMatchObject({ ok: true, value: { hour: Number(hour) } });
  });

  it.each(["24", "-1", "7.5", "", "seven", "007", undefined])("rejects the hour %s", (hour) => {
    expect(validateDailyJobs({ ...base, hour }, can)).toMatchObject({ ok: false, errors: { hour: expect.any(String) } });
  });

  it.each(["Mars/Olympus", "Europe/Paris; DROP", "", "local", "../etc/passwd", "Europe/" + "x".repeat(80)])(
    "rejects the time zone %s",
    (timezone) => {
      expect(validateDailyJobs({ ...base, timezone }, can)).toMatchObject({
        ok: false,
        errors: { timezone: expect.any(String) },
      });
    },
  );

  it("accepts UTC and stores a renamed zone under the runtime name", () => {
    expect(validateDailyJobs({ ...base, timezone: "UTC" }, can)).toMatchObject({ value: { timezone: "UTC" } });
    // V8 знає Київ як Europe/Kiev, браузер може прислати Europe/Kyiv: зводимо до назви рушія.
    expect(validateDailyJobs({ ...base, timezone: "Europe/Kyiv" }, can)).toMatchObject({
      ok: true,
      value: { timezone: expect.stringMatching(/^Europe\/(Kyiv|Kiev)$/) },
    });
  });

  it("refuses Telegram until it is linked, and email without an address", () => {
    expect(validateDailyJobs({ ...base, channel: "telegram" }, can)).toMatchObject({
      ok: false,
      errors: { channel: "Connect Telegram first." },
    });
    expect(validateDailyJobs({ ...base, channel: "telegram" }, { email: false, telegram: true })).toMatchObject({
      ok: true,
    });
    expect(validateDailyJobs(base, { email: false, telegram: true })).toMatchObject({ ok: false });
    expect(validateDailyJobs({ ...base, channel: "sms" }, can)).toMatchObject({ ok: false });
  });

  it("reads the pause box", () => {
    expect(validateDailyJobs({ ...base, paused: "on" }, can)).toMatchObject({ value: { paused: true } });
    expect(validateDailyJobs({ ...base, paused: "" }, can)).toMatchObject({ value: { paused: false } });
  });
});

describe("saveDailyJobs and the pause flag", () => {
  it("is not paused by default and saves pause, hour, zone and channel", async () => {
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ digestPaused: false, digestHour: 7, timezone: null });
    await saveDailyJobs(t.d1, "a", { channel: "email", hour: 21, timezone: "Asia/Tokyo", paused: true });
    expect(one("SELECT channel, digest_hour, timezone, digest_paused FROM users")).toEqual({
      channel: "email",
      digest_hour: 21,
      timezone: "Asia/Tokyo",
      digest_paused: 1,
    });
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ digestPaused: true, digestHour: 21 });
    await saveDailyJobs(t.d1, "a", { channel: "email", hour: 21, timezone: "Asia/Tokyo", paused: false });
    expect(one("SELECT digest_paused FROM users")).toEqual({ digest_paused: 0 });
  });
});

describe("detectTimezone", () => {
  it("fills an empty zone once and never overwrites a saved one", async () => {
    await expect(detectTimezone(t.d1, "a", "Europe/Paris")).resolves.toBe("Europe/Paris");
    await expect(detectTimezone(t.d1, "a", "Asia/Tokyo")).resolves.toBeNull();
    expect(one("SELECT timezone FROM users")).toEqual({ timezone: "Europe/Paris" });
  });

  it("ignores a zone outside the list", async () => {
    await expect(detectTimezone(t.d1, "a", "Nowhere/Land")).resolves.toBeNull();
    expect(one("SELECT timezone FROM users")).toEqual({ timezone: null });
  });
});

describe("acceptTerms (the last button of the brief, no boxes)", () => {
  it("writes one consent event (the terms) and the default settings as state, in one batch, then tells the CRM", async () => {
    const batch = vi.spyOn(t.d1, "batch");
    await expect(acceptTerms(t.d1, "a")).resolves.toEqual({ visible: true, direct: true, accepted: true });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(all("SELECT kind, granted, text_version FROM consent_events")).toEqual([
      { kind: "terms", granted: 1, text_version: "terms-0.2" },
    ]);
    expect(one("SELECT visible_to_companies AS v, contact_mode FROM users")).toEqual({ v: 1, contact_mode: "direct" });
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ visible: true, contactMode: "direct", scoringConsent: true });
    expect(hooks.notifyCrmVisibility).toHaveBeenCalledWith("a", true);
  });

  it("a second press with the same terms writes nothing new", async () => {
    await acceptTerms(t.d1, "a");
    hooks.notifyCrmVisibility.mockClear();
    await expect(acceptTerms(t.d1, "a")).resolves.toEqual({ visible: true, direct: true, accepted: false });
    expect(all("SELECT COUNT(*) AS n FROM consent_events")).toEqual([{ n: 1 }]);
    expect(hooks.notifyCrmVisibility).not.toHaveBeenCalled();
  });

  it("keeps what the person already chose in Settings", async () => {
    scoringConsent();
    await setVisibility(t.d1, "a", true);
    await setVisibility(t.d1, "a", false);
    await setContactMode(t.d1, "a", "direct");
    await setContactMode(t.d1, "a", "approval");
    await expect(acceptTerms(t.d1, "a")).resolves.toEqual({ visible: false, direct: false, accepted: true });
    expect(one("SELECT visible_to_companies AS v, contact_mode FROM users")).toEqual({ v: 0, contact_mode: "approval" });
  });

  it("the switches in Settings still turn the defaults off", async () => {
    await acceptTerms(t.d1, "a");
    await expect(setVisibility(t.d1, "a", false)).resolves.toEqual({ ok: true, changed: true });
    await expect(setContactMode(t.d1, "a", "approval")).resolves.toMatchObject({ ok: true, changed: true });
    await expect(loadSettings(t.d1, "a")).resolves.toMatchObject({ visible: false, contactMode: "approval" });
  });
});

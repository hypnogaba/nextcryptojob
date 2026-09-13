import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, run } from "@/test/crm-fixtures";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import {
  BANNER_MAX_LENGTH,
  DEFAULT_SETTINGS,
  getSettings,
  loadSettings,
  resetSettingsCache,
  SETTINGS_CACHE_TTL_MS,
  siteNotice,
  updateSettings,
} from "./settings";

/**
 * Налаштування з адмінки (app_settings, 0019): типований реєстр, значення за замовчуванням
 * на все криве чи відсутнє, кеш на хвилину, запис лише зміненого з рядком журналу.
 */

let db: TestDb;

beforeEach(() => {
  db = crmDb();
  resetSettingsCache();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** D1, що рахує інструкції. */
function counting(d1: D1Database): { d1: D1Database; reads: () => number } {
  let n = 0;
  return {
    d1: { ...d1, prepare: (sql: string) => (n++, d1.prepare(sql)), batch: d1.batch.bind(d1) } as D1Database,
    reads: () => n,
  };
}

describe("loadSettings", () => {
  it("gives the defaults without rows: sign-ups open, no notice", async () => {
    const loaded = await loadSettings(db.d1);
    expect(loaded.values).toEqual({ signups_open: true, company_signups_open: true, banner_message: "", banner_level: "info" });
    expect(loaded.error).toBeNull();
    expect(siteNotice(loaded.values)).toBeNull();
  });

  it("reads stored values and ignores unknown keys, bad JSON and values that fail the registry", async () => {
    run(
      db.raw,
      `INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES
         ('signups_open', 'false', '2026-09-13 10:00:00', NULL),
         ('banner_message', '"Digests are late today."', '2026-09-13 10:00:00', NULL),
         ('banner_level', '"loud"', '2026-09-13 10:00:00', NULL),
         ('company_signups_open', 'not json', '2026-09-13 10:00:00', NULL),
         ('company_trial_days', '30', '2026-09-13 10:00:00', NULL)`,
    );
    const loaded = await loadSettings(db.d1);
    expect(loaded.values).toEqual({
      signups_open: false,
      company_signups_open: true,
      banner_message: "Digests are late today.",
      banner_level: "info",
    });
    expect(Object.keys(loaded.meta).sort()).toEqual(["banner_message", "signups_open"]);
    expect(siteNotice(loaded.values)).toEqual({ message: "Digests are late today.", level: "info" });
  });

  it("falls back to the defaults (sign-ups open) when the table is missing, and says why", async () => {
    const bare = migratedD1([]).d1;
    const loaded = await loadSettings(bare);
    expect(loaded.values).toEqual(DEFAULT_SETTINGS);
    expect(loaded.error).toContain("no such table");
  });
});

describe("getSettings cache", () => {
  it("reads the table once per minute per isolate, also when the read fails", async () => {
    const t0 = Date.parse("2026-09-13T10:00:00Z");
    const c = counting(db.d1);
    await getSettings(c.d1, t0);
    await getSettings(c.d1, t0 + SETTINGS_CACHE_TTL_MS - 1);
    expect(c.reads()).toBe(1);
    await getSettings(c.d1, t0 + SETTINGS_CACHE_TTL_MS);
    expect(c.reads()).toBe(2);

    resetSettingsCache();
    const broken = counting(migratedD1([]).d1);
    expect(await getSettings(broken.d1, t0)).toEqual(DEFAULT_SETTINGS);
    await getSettings(broken.d1, t0 + 1000);
    expect(broken.reads()).toBe(1);
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    run(db.raw, "INSERT INTO users (id, email) VALUES ('boss', 'boss@example.com')");
  });

  it("writes only the changed keys, each with an audit row, and the next read sees them at once", async () => {
    const t0 = Date.parse("2026-09-13T10:00:00Z");
    expect((await getSettings(db.d1, t0)).signups_open).toBe(true);

    const res = await updateSettings(db.d1, {
      adminUserId: "boss",
      values: { signups_open: false, company_signups_open: true },
      now: new Date("2026-09-13T10:00:30Z"),
    });
    expect(res).toEqual({ ok: true, changed: ["signups_open"] });
    expect(all(db.raw, "SELECT key, value_json, updated_at, updated_by FROM app_settings")).toEqual([
      { key: "signups_open", value_json: "false", updated_at: "2026-09-13 10:00:30", updated_by: "boss" },
    ]);
    expect(all(db.raw, "SELECT actor, action, target, meta_json FROM audit_log")).toEqual([
      {
        actor: "admin:boss",
        action: "settings.update",
        target: "setting:signups_open",
        meta_json: '{"key":"signups_open","from":true,"to":false}',
      },
    ]);
    // Кеш цього ізоляту скинуто: зміна діє одразу, не через хвилину.
    expect((await getSettings(db.d1, t0 + 31_000)).signups_open).toBe(false);

    // Те саме вдруге: нічого не пишемо.
    expect(await updateSettings(db.d1, { adminUserId: "boss", values: { signups_open: false } })).toEqual({ ok: true, changed: [] });
    expect(all(db.raw, "SELECT id FROM audit_log")).toHaveLength(1);
  });

  it("cleans the notice to one line of plain text and refuses a notice over the limit or an unknown style", async () => {
    await updateSettings(db.d1, {
      adminUserId: "boss",
      values: { banner_message: "  Digests\nare\tlate \u2014 sorry  ", banner_level: "warning" },
    });
    const { values } = await loadSettings(db.d1);
    expect(values.banner_message).toBe("Digests are late - sorry");
    expect(values.banner_level).toBe("warning");

    const long = await updateSettings(db.d1, { adminUserId: "boss", values: { banner_message: "x".repeat(BANNER_MAX_LENGTH + 1) } });
    expect(long).toMatchObject({ ok: false, errors: { banner_message: expect.stringContaining(`${BANNER_MAX_LENGTH} characters`) } });
    const loud = await updateSettings(db.d1, { adminUserId: "boss", values: { banner_level: "loud", signups_open: false } });
    expect(loud).toMatchObject({ ok: false, errors: { banner_level: "Choose Info or Warning." } });
    // Помилка в одному ключі: не пишемо жодного.
    expect((await loadSettings(db.d1)).values.signups_open).toBe(true);
    expect(all(db.raw, "SELECT target FROM audit_log ORDER BY id")).toEqual([
      { target: "setting:banner_message" },
      { target: "setting:banner_level" },
    ]);
  });

  it("refuses to save when the table is missing instead of pretending it saved", async () => {
    const bare = migratedD1(["0001_core.sql", "0002_auth.sql"]);
    run(bare.raw, "INSERT INTO users (id) VALUES ('boss')");
    const res = await updateSettings(bare.d1, { adminUserId: "boss", values: { signups_open: false } });
    expect(res).toMatchObject({ ok: false, unavailable: expect.stringContaining("no such table") });
    expect(all(bare.raw, "SELECT id FROM audit_log")).toEqual([]);
  });
});

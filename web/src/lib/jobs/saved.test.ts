import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { isJobRef, listSavedRefs, saveJob, unsaveJob } from "./saved";

let t: TestDb;

beforeEach(() => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')");
});

describe("isJobRef", () => {
  it.each(["nr:abc123", "co:abc_DEF-9"])("accepts %j", (ref) => expect(isJobRef(ref)).toBe(true));
  it.each(["", "abc", "nr:", "sql:1 OR 1=1", 42, null, undefined])("rejects %j", (ref) => expect(isJobRef(ref)).toBe(false));
});

describe("saveJob / unsaveJob / listSavedRefs", () => {
  it("saves and lists a job for one person, not for another", async () => {
    await saveJob(t.d1, "u1", "nr:abc123");
    expect(await listSavedRefs(t.d1, "u1")).toEqual(new Set(["nr:abc123"]));
    expect(await listSavedRefs(t.d1, "u2")).toEqual(new Set());
  });

  it("is idempotent: saving the same job twice keeps one row", async () => {
    await saveJob(t.d1, "u1", "nr:abc123");
    await saveJob(t.d1, "u1", "nr:abc123");
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM saved_jobs").get()).toEqual({ n: 1 });
  });

  it("unsaves", async () => {
    await saveJob(t.d1, "u1", "nr:abc123");
    await unsaveJob(t.d1, "u1", "nr:abc123");
    expect(await listSavedRefs(t.d1, "u1")).toEqual(new Set());
  });

  it("silently ignores a malformed ref instead of saving garbage", async () => {
    await saveJob(t.d1, "u1", "'; DROP TABLE saved_jobs; --");
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM saved_jobs").get()).toEqual({ n: 0 });
  });
});

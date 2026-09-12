import { describe, expect, it } from "vitest";
import { assertReadOnlySql, readOnlyJobsDb, ReadOnlySqlError } from "./jobs-db";

function fakeD1(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const binding = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            all: async () => ({ results: rows, success: true, meta: {} }),
            first: async () => rows[0] ?? null,
          };
        },
      };
    },
  };
  return { binding: binding as unknown as D1Database, calls };
}

describe("assertReadOnlySql accepts single reads", () => {
  it.each([
    "SELECT id, title FROM jobs WHERE id = ?",
    "  select count(*) from jobs;  ",
    "WITH recent AS (SELECT * FROM jobs WHERE fetched_at > ?) SELECT id FROM recent",
    "SELECT replace(title, 'a', 'b') FROM jobs",
    "SELECT updated_at, created_at FROM jobs",
    "SELECT 'DROP TABLE jobs; DELETE FROM jobs' AS text",
    'SELECT "delete" FROM jobs',
    "SELECT id FROM jobs -- trailing comment; DELETE FROM jobs",
    "SELECT id /* ; insert */ FROM jobs",
    "SELECT name FROM pragma_table_info('jobs')",
  ])("%s", (sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });
});

describe("assertReadOnlySql rejects anything else", () => {
  it.each([
    ["", "empty"],
    ["   ;  ", "empty"],
    ["DELETE FROM jobs", "not a read"],
    ["UPDATE jobs SET title = 'x'", "not a read"],
    ["INSERT INTO jobs(id) VALUES (1)", "not a read"],
    ["REPLACE INTO jobs(id) VALUES (1)", "not a read"],
    ["DROP TABLE jobs", "not a read"],
    ["PRAGMA table_info(jobs)", "not a read"],
    ["ATTACH DATABASE 'x' AS y", "not a read"],
    ["SELECT 1; DELETE FROM jobs", "two statements"],
    ["SELECT 1; SELECT 2", "two statements"],
    ["WITH x AS (SELECT 1) DELETE FROM jobs", "DML behind WITH"],
    ["WITH x AS (SELECT 1) UPDATE jobs SET title = 'x'", "DML behind WITH"],
    ["WITH x AS (SELECT 1) INSERT INTO jobs SELECT * FROM x", "DML behind WITH"],
    ["SELECT 'unterminated", "broken quote"],
    ["SELECT 1 /* unterminated", "broken comment"],
    ["/* hide */ DELETE FROM jobs", "comment before DML"],
  ])("%s (%s)", (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlySqlError);
  });
});

describe("readOnlyJobsDb", () => {
  it("runs a SELECT with bound parameters and returns rows", async () => {
    const { binding, calls } = fakeD1([{ id: 1 }, { id: 2 }]);
    const db = readOnlyJobsDb(binding);
    await expect(db.all("SELECT id FROM jobs WHERE role = ?", "engineer")).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    await expect(db.first("SELECT id FROM jobs LIMIT 1")).resolves.toEqual({ id: 1 });
    expect(calls).toEqual([
      { sql: "SELECT id FROM jobs WHERE role = ?", params: ["engineer"] },
      { sql: "SELECT id FROM jobs LIMIT 1", params: [] },
    ]);
  });

  it("never sends a write to the database", async () => {
    const { binding, calls } = fakeD1([]);
    const db = readOnlyJobsDb(binding);
    await expect(db.all("DELETE FROM jobs")).rejects.toThrow(ReadOnlySqlError);
    await expect(db.first("SELECT 1; DROP TABLE jobs")).rejects.toThrow(ReadOnlySqlError);
    expect(calls).toEqual([]);
  });
});

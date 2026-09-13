import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/lib/crm/actions";
import { addMember, addScore, addUser, all, contextFor, crmDb, publishFormula, run, setConsent } from "@/test/crm-fixtures";
import { addTestCompany, BOT_TOKEN, linkTelegram, nextTelegramId, NOW, stubNetwork, type Network, type TestCompany } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { savedSearchAlerts } from "./alerts";

/**
 * Щоденні сповіщення збережених пошуків (5.7, рішення T7 про baseline_at): нові =
 * видимі збіги, чия видимість чи бал змінились після max(baseline_at, last_alert_at),
 * про кого пошук ще не сповіщав; кожен пошук не частіше разу на 24 год; без
 * підписки на паузі; повтор запуску не шле двох листів; компанії окремо.
 */

let db: TestDb;
let net: Network;
let c: TestCompany;

const notifier = { botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" };
const OLD = "2026-09-01 00:00:00";
/** NOW = 2026-09-12 12:00 UTC: мить створення пошуку (baseline_at). */
const hour = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

beforeEach(async () => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  c = await addTestCompany(db, net);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Видимий інженер: згода visibility і бал з заданими мітками часу. */
function engineer(o: { consentAt?: string; computedAt?: string; visible?: boolean; roles?: string[] } = {}): string {
  const id = addUser(db.raw, { roles: o.roles ?? ["engineer"], visible: o.visible ?? true, consentAt: o.consentAt ?? OLD });
  addScore(db.raw, id, (o.roles ?? ["engineer"])[0], 80, { computedAt: o.computedAt ?? OLD });
  return id;
}

async function saveSearch(ctx = c.owner, name = "Solidity engineers"): Promise<string> {
  const res = await runAction("create_saved_search", { name, filters: { role: "engineer" } }, ctx);
  return (res.output as { saved_search_id: string }).saved_search_id;
}

const row = (id: string) =>
  all<{ last_alert_at: string | null; last_match_count: number | null; seen_json: string }>(
    db.raw,
    "SELECT last_alert_at, last_match_count, seen_json FROM saved_searches WHERE id = ?",
    id,
  )[0];
/** Текст повідомлень бота без HTML-сутностей (parse_mode HTML екранує лапки). */
const texts = (chat: string) =>
  net.messagesTo(chat).map((m) => String(m.payload.text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

describe("savedSearchAlerts", () => {
  it("reports only candidates whose visibility or score changed since the baseline, once each, at most daily", async () => {
    const old = engineer();
    const rescored = engineer({ computedAt: "2026-09-12 12:30:00" });
    engineer({ visible: false, computedAt: "2026-09-12 12:30:00" });
    engineer({ roles: ["designer"], computedAt: "2026-09-12 12:30:00" });
    const ss = await saveSearch();

    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(1) })).toMatchObject({ checked: 1, alerted: 1, newCandidates: 1 });
    expect(row(ss)).toMatchObject({ last_alert_at: "2026-09-12 13:00:00", last_match_count: 1 });
    expect(JSON.parse(row(ss).seen_json)).toEqual([rescored]);
    const msgs = texts(c.ownerTelegram);
    expect(msgs.at(-1)).toContain('1 new candidate matches "Solidity engineers"');
    expect(msgs.at(-1)).toContain("/company/search?role=engineer");
    expect(JSON.stringify(msgs)).not.toContain(old);

    // Той самий запуск ще раз і будь-який до 24 год: пошук не на черзі.
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(1) })).toMatchObject({ checked: 0 });
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(24) })).toMatchObject({ checked: 0 });

    // Наступна доба: новий видимий кандидат і перерахований бал того, про кого вже казали.
    const joined = engineer({ consentAt: OLD });
    setConsent(db.raw, joined, "visibility", true, "2026-09-13 10:00:00");
    run(db.raw, "UPDATE scores SET computed_at = '2026-09-13 09:00:00' WHERE user_id = ?", rescored);
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(25) })).toMatchObject({ checked: 1, alerted: 1, newCandidates: 1 });
    expect(JSON.parse(row(ss).seen_json)).toEqual([rescored, joined]);

    // Третя доба без змін: перевірено, 0 нових, повідомлення немає.
    const before = net.tg.length;
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(49) })).toMatchObject({ checked: 1, alerted: 0 });
    expect(row(ss)).toMatchObject({ last_alert_at: "2026-09-14 13:00:00", last_match_count: 0 });
    expect(net.tg.length).toBe(before);
  });

  it("counts from the new baseline after the filters change", async () => {
    engineer({ computedAt: "2026-09-12 12:30:00" });
    const ss = await saveSearch();
    await runAction("update_saved_search", { saved_search_id: ss, filters: { role: "engineer", min_score: 50 } }, { ...c.owner, now: hour(2) });
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(3) })).toMatchObject({ checked: 1, alerted: 0 });
    expect(row(ss).last_match_count).toBe(0);
  });

  it("pauses without a subscription and skips searches with the alert off", async () => {
    engineer({ computedAt: "2026-09-12 12:30:00" });
    const ss = await saveSearch();
    const other = await saveSearch(c.owner, "Off");
    await runAction("update_saved_search", { saved_search_id: other, alert: "off" }, c.owner);
    run(db.raw, "UPDATE subscriptions SET current_period_end = '2026-09-01 00:00:00' WHERE company_id = ?", c.co);
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(1) })).toMatchObject({ checked: 0, alerted: 0 });
    expect(row(ss).last_alert_at).toBeNull();
    expect(row(other).last_alert_at).toBeNull();
  });

  it("tells the member who saved it; for an agent's search or a creator who left, the owners", async () => {
    engineer({ computedAt: "2026-09-12 12:30:00" });
    const mia = addUser(db.raw, { visible: false, email: "mia@acme.io" });
    const miaChat = nextTelegramId();
    linkTelegram(db, mia, miaChat);
    addMember(db.raw, c.co, mia, "member");
    const miaCtx = await contextFor(db, { sessionUserId: mia }, { now: NOW, env: c.owner.env });
    await saveSearch(miaCtx, "Mia's search");
    await saveSearch(c.agent, "Agent's search");

    await savedSearchAlerts(db.d1, { notifier, now: hour(1) });
    expect(texts(miaChat).join("\n")).toContain("Mia's search");
    expect(texts(miaChat).join("\n")).not.toContain("Agent's search");
    expect(texts(c.ownerTelegram).join("\n")).toContain("Agent's search");
    expect(texts(c.ownerTelegram).join("\n")).not.toContain("Mia's search");

    // Мія пішла з команди: наступне сповіщення її пошуку йде власникам.
    run(db.raw, "DELETE FROM company_members WHERE user_id = ?", mia);
    const joined = engineer();
    setConsent(db.raw, joined, "visibility", true, "2026-09-13 10:00:00");
    await savedSearchAlerts(db.d1, { notifier, now: hour(25) });
    expect(texts(c.ownerTelegram).join("\n")).toContain("Mia's search");
  });

  it("an alert is never lost: a run that dies before sending, or after sending but before marking, is repeated next hour", async () => {
    engineer({ computedAt: "2026-09-12 12:30:00" });
    const ss = await saveSearch();
    const alerts = () => texts(c.ownerTelegram).filter((t) => t.includes("new candidate"));

    // Падіння до надсилання (читання адресатів): нічого не надіслано й нічого не позначено.
    const beforeSend = failingOnce(db.d1, /SELECT u\.channel/);
    expect(await savedSearchAlerts(beforeSend, { notifier, now: hour(1) })).toMatchObject({ errors: 1, checked: 0 });
    expect(alerts()).toHaveLength(0);
    expect(row(ss).last_alert_at).toBeNull();

    // Наступна година: надіслано, але падіння на позначці. Пошук лишається на черзі.
    const beforeMark = failingOnce(db.d1, /UPDATE saved_searches SET last_alert_at/);
    expect(await savedSearchAlerts(beforeMark, { notifier, now: hour(2) })).toMatchObject({ errors: 1, alerted: 1, checked: 0 });
    expect(alerts()).toHaveLength(1);
    expect(row(ss).last_alert_at).toBeNull();

    // Ще година: надіслано вдруге (щонайменше раз) і позначено.
    expect(await savedSearchAlerts(db.d1, { notifier, now: hour(3) })).toMatchObject({ alerted: 1, checked: 1 });
    expect(alerts()).toHaveLength(2);
    expect(row(ss)).toMatchObject({ last_alert_at: "2026-09-12 15:00:00", last_match_count: 1 });
  });

  it("stops at the run's deadline and leaves the rest for the next hour", async () => {
    engineer({ computedAt: "2026-09-12 12:30:00" });
    const ss = await saveSearch();
    const res = await savedSearchAlerts(db.d1, { notifier, now: hour(1), deadline: 0, clock: () => hour(1) });
    expect(res).toMatchObject({ deferred: 1, checked: 0 });
    expect(row(ss).last_alert_at).toBeNull();
  });

  it("keeps companies apart: a teammate or a candidate who blocked the company is not a match for it", async () => {
    const other = await addTestCompany(db, net, { name: "Beta Corp" });
    const teammate = engineer({ computedAt: "2026-09-12 12:30:00" });
    addMember(db.raw, c.co, teammate, "member");
    const blocker = engineer({ computedAt: "2026-09-12 12:30:00" });
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, candidate_blocked, respond_token_hash)
       VALUES ('int_blockedAAAAAAAAAAAAA', ?, ?, 'approval', 'declined', 'x', 'web', '2026-09-20 00:00:00', 1, NULL)`,
      c.co,
      blocker,
    );
    const mine = await saveSearch();
    const theirs = await saveSearch(other.owner, "Beta search");

    await savedSearchAlerts(db.d1, { notifier, now: hour(1) });
    expect(row(mine).last_match_count).toBe(0);
    expect(JSON.parse(row(theirs).seen_json).sort()).toEqual([teammate, blocker].sort());
    expect(texts(c.ownerTelegram).join("\n")).not.toContain("Beta search");
    expect(texts(other.ownerTelegram).join("\n")).toContain('2 new candidates match "Beta search"');
  });
});

/** База, у якій перша інструкція, що збігається з `pattern`, кидає (процес «упав» саме там). */
function failingOnce(d1: D1Database, pattern: RegExp): D1Database {
  let armed = true;
  const boom = () => {
    armed = false;
    throw new Error("D1_ERROR: simulated crash");
  };
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!armed || !pattern.test(sql)) return stmt;
        const fail = { first: boom, all: boom, run: boom, bind: () => fail };
        return fail;
      };
    },
  }) as D1Database;
}


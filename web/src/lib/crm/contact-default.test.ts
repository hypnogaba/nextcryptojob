import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWelcomeSharing } from "@/lib/account/settings";
import { crmDb, publishFormula, run } from "@/test/crm-fixtures";
import { addCandidate, addTestCompany, ask, stubNetwork, type Network, type TestCompany } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import type { CandidateSummary } from "./types";

// Власник 14.09: нові люди видимі й показують Telegram-нік напряму за замовчуванням.
// Людей тут створюємо тим самим записом, що й крок згоди анкети (applyWelcomeSharing),
// і перевіряємо, що пошук, профіль і знайомство кажуть те саме, а пошта не витікає.

vi.mock("@/lib/account/hooks", () => ({ notifyCrmVisibility: async () => {} }));

let db: TestDb;
let net: Network;
let c: TestCompany;

beforeEach(async () => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  c = await addTestCompany(db, net);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Людина, що пройшла крок згоди з вибором `choice` (до нього прихована, як нова). */
async function welcomed(
  choice: { visible: boolean; direct: boolean },
  o: { telegram?: string | null; telegramId?: string | null; email?: string | null } = {},
) {
  const who = addCandidate(db, { visible: false, consent: false, ...o });
  run(db.raw, "INSERT INTO consents (user_id, kind, granted, text_version) VALUES (?, 'scoring', 1, 'v1')", who.id);
  await applyWelcomeSharing(db.d1, who.id, choice);
  return who;
}

async function searchRow(id: string): Promise<CandidateSummary | undefined> {
  const res = (await runAction("search_candidates", { filters: {} }, c.agent)) as { output: { data: CandidateSummary[] } };
  return res.output.data.find((r) => r.candidate_id === id);
}

async function profile(id: string): Promise<CandidateSummary> {
  return ((await runAction("get_candidate", { candidate_id: id }, c.agent)) as { output: CandidateSummary }).output;
}

describe("new candidates with the defaults (visible, Telegram directly)", () => {
  it("with a Telegram username: search, profile and intro all say direct, and the intro returns the handle", async () => {
    const alice = await welcomed({ visible: true, direct: true }, { telegram: "alice_eth" });
    expect((await searchRow(alice.id))?.contact_mode).toBe("direct");
    expect((await profile(alice.id)).contact_mode).toBe("direct");
    const res = await ask(c.agent, alice.id);
    expect(res.output).toMatchObject({ status: "direct", mode: "direct", contact: { kind: "telegram", value: "@alice_eth" } });
  });

  it("without a Telegram username: companies see Request intro (approval) and the email never leaks", async () => {
    const email = "bob.private@gmail.com";
    const bob = await welcomed({ visible: true, direct: true }, { telegram: null, telegramId: null, email });
    const row = await searchRow(bob.id);
    expect(row?.contact_mode).toBe("approval");
    const view = await profile(bob.id);
    expect(view.contact_mode).toBe("approval");
    const res = await ask(c.agent, bob.id);
    expect(res.output).toMatchObject({ status: "pending", mode: "approval", contact: null });
    expect(JSON.stringify([row, view, res.output])).not.toContain(email);
    expect(JSON.stringify(await profile(bob.id))).not.toContain(email);
  });
});

describe("opting out at the consent step", () => {
  it("hidden: not in search, and the profile is not found", async () => {
    const carol = await welcomed({ visible: false, direct: true }, { telegram: "carol" });
    expect(await searchRow(carol.id)).toBeUndefined();
    await expect(runAction("get_candidate", { candidate_id: carol.id }, c.agent)).rejects.toMatchObject({ status: 404 });
  });

  it("only after approval: visible, but the handle comes only after a yes", async () => {
    const dan = await welcomed({ visible: true, direct: false }, { telegram: "dan" });
    expect((await searchRow(dan.id))?.contact_mode).toBe("approval");
    const res = await ask(c.agent, dan.id);
    expect(res.output).toMatchObject({ status: "pending", mode: "approval", contact: null });
  });
});

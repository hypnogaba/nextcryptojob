import { beforeEach, describe, expect, it } from "vitest";
import { addCompany, addMember, addScore, addSubscription, addUser, all, contextFor, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import type { ActionContext } from "./context";
import { changeTag } from "./pipeline";
import { ActionError } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

async function setup(): Promise<{ ctx: ActionContext; id: string }> {
  const co = addCompany(db.raw);
  addSubscription(db.raw, co);
  const member = addUser(db.raw, { visible: false });
  addMember(db.raw, co, member, "member");
  const ctx = await contextFor(db, { sessionUserId: member });
  const id = addUser(db.raw);
  addScore(db.raw, id, "engineer", 70);
  await runAction("add_to_pipeline", { candidate_id: id }, ctx);
  return { ctx, id };
}

/** Інша вкладка пише свою зміну між читанням картки і пакетом цієї дії. */
function withRaceBeforeBatch(ctx: ActionContext, race: () => void): ActionContext {
  let fired = false;
  const real = ctx.db;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!fired) {
            fired = true;
            race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...ctx, db };
}

const tags = () => JSON.parse(all<{ tags: string }>(db.raw, "SELECT tags FROM pipeline")[0].tags) as string[];

describe("changeTag: one UPDATE over the current tag list", () => {
  it("a tag added by another tab between read and write is not lost", async () => {
    const { ctx, id } = await setup();
    const racing = withRaceBeforeBatch(ctx, () => run(db.raw, "UPDATE pipeline SET tags = json_insert(tags, '$[#]', 'lending')"));
    const card = await changeTag(racing, { candidate_id: id, add: "solidity" });
    expect(card.tags).toEqual(["lending", "solidity"]);
    expect(tags()).toEqual(["lending", "solidity"]);
  });

  it("a removal does not drop a tag another tab added meanwhile", async () => {
    const { ctx, id } = await setup();
    await changeTag(ctx, { candidate_id: id, add: "Solidity" });
    const racing = withRaceBeforeBatch(ctx, () => run(db.raw, "UPDATE pipeline SET tags = json_insert(tags, '$[#]', 'defi')"));
    await changeTag(racing, { candidate_id: id, remove: "SOLIDITY" });
    expect(tags()).toEqual(["defi"]);
  });

  it("the same tag in another case added meanwhile is not added twice; non-latin case too", async () => {
    const { ctx, id } = await setup();
    const racing = withRaceBeforeBatch(ctx, () => run(db.raw, "UPDATE pipeline SET tags = json_insert(tags, '$[#]', 'RUST')"));
    await changeTag(racing, { candidate_id: id, add: "rust" });
    expect(tags()).toEqual(["RUST"]);
    await changeTag(ctx, { candidate_id: id, add: "Київ" });
    await changeTag(ctx, { candidate_id: id, add: "КИЇВ" });
    expect(tags()).toEqual(["RUST", "Київ"]);
    // Подія й журнал лише на справжні зміни: з трьох спроб змінила картку одна (Київ).
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM pipeline_events WHERE kind = 'tags_changed'")).toEqual([{ n: 1 }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pipeline.tags'")).toEqual([{ n: 1 }]);
  });

  it("the tenth tag filled meanwhile stops the eleventh; another company's card is not found", async () => {
    const { ctx, id } = await setup();
    const ten = JSON.stringify(Array.from({ length: 10 }, (_, i) => `t${i}`));
    const racing = withRaceBeforeBatch(ctx, () => run(db.raw, "UPDATE pipeline SET tags = ?", ten));
    const e = await changeTag(racing, { candidate_id: id, add: "eleven" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).details).toEqual({ fields: { tags: "Use at most 10 tags." } });
    expect(tags()).toHaveLength(10);

    const other = addCompany(db.raw, { name: "Beta" });
    addSubscription(db.raw, other);
    const stranger = addUser(db.raw, { visible: false });
    addMember(db.raw, other, stranger, "owner");
    const b = await contextFor(db, { sessionUserId: stranger });
    await expect(changeTag(b, { candidate_id: id, add: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(tags()).toHaveLength(10);
  });
});

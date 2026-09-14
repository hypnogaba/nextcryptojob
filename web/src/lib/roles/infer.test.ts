import { describe, expect, it } from "vitest";
import { TARGET_EXAMPLES } from "@/app/welcome/steps/target-form";
import { DEFAULT_CLOSEST, guessRoles, inferRoles, MIN_WEIGHT, roleWeights, similarity } from "./infer";

describe("inferRoles: the role from the person's own words, no picker", () => {
  it("reads the owner's example as BD only, not Engineer from 'DeFi protocol'", () => {
    const text = "BD lead at a DeFi protocol, remote, from 3,000 EUR a month, I closed 20+ partnerships at X";
    expect(inferRoles(text)).toEqual(["bd"]);
    // «protocol» дає інженеру вагу 1: нижче порога, тож не пропонуємо.
    expect(roleWeights(text).get("engineer")).toBeLessThan(MIN_WEIGHT);
  });

  it("gives two roles when the person names two", () => {
    expect(inferRoles("I want BD or marketing in a L2")).toEqual(["bd", "marketing_content"]);
  });

  it("uses the job-title rules of the digest (head words, synonyms) and words people write about themselves", () => {
    // Комʼюніті в крипті часто частина маркетингу (власник 14.09), тож маркетинг другим.
    expect(inferRoles("Community manager for a gaming project, I ran weekly AMAs")).toEqual(["community", "marketing_content"]);
    expect(inferRoles("Smart contract auditor, Code4rena top 50")).toEqual(["security_auditor"]);
    expect(inferRoles("product manager for a wallet")).toEqual(["product_manager"]);
    expect(inferRoles("I'm a KOL with 20k followers, want ambassador roles")).toEqual(["creator_kol"]);
    expect(inferRoles("tokenomics research for a new L1")).toEqual(["data_research"]);
    expect(inferRoles("growth hacker, KOL campaigns")).toEqual(["marketing_content", "creator_kol"]);
  });

  it("reads Ukrainian and Russian", () => {
    expect(inferRoles("Хочу працювати трейдером у фонді")).toEqual(["trader"]);
    expect(inferRoles("Шукаю роботу менеджера з партнерств, віддалено")).toEqual(["bd"]);
    expect(inferRoles("Ищу работу разработчиком смарт-контрактов")).toEqual(["engineer"]);
  });

  it("returns nothing when nothing is clear, so the page asks instead of guessing", () => {
    expect(inferRoles("something unrelated like cooking")).toEqual([]);
    expect(inferRoles("")).toEqual([]);
    expect(inferRoles("I like data")).toEqual([]);
  });

  it("reads a community manager brief written in Ukrainian as community and marketing (the owner's case, paraphrased)", () => {
    // Власник 14.09 написав «комуніті» (так пишуть українською) і не отримав жодної ролі.
    expect(inferRoles("комуніті-менеджерка в Лісабоні чи Варшаві")).toEqual(["community", "marketing_content"]);
    expect(guessRoles("шукаю роботу комуніті менеджера, можна в Мадриді")).toEqual({
      roles: ["community", "marketing_content"],
      confident: true,
    });
  });

  it.each([
    // Англійською
    ["community manager in Lisbon or remote", ["community", "marketing_content"]],
    ["Community lead for a DAO, remote", ["community", "marketing_content"]],
    ["Discord moderator", ["community"]],
    ["head of community and socials", ["community"]],
    ["Head of growth at a DeFi protocol", ["marketing_content"]],
    ["growth marketer, remote", ["marketing_content"]],
    ["content writer for a web3 media", ["marketing_content"]],
    ["social media manager, twitter and telegram", ["marketing_content"]],
    ["PR and comms manager", ["marketing_content"]],
    ["event manager for conferences", ["marketing_content"]],
    ["copywriter", ["marketing_content"]],
    ["I want to work in marketing", ["marketing_content"]],
    ["KOL manager", ["creator_kol", "marketing_content"]],
    ["ambassador program lead", ["creator_kol"]],
    ["BD manager at an exchange", ["bd"]],
    ["business developer", ["bd"]],
    ["partnerships lead", ["bd"]],
    ["sales at a crypto startup", ["bd"]],
    ["ecosystem manager", ["bd"]],
    ["product manager for a wallet", ["product_manager"]],
    ["project manager", ["product_manager"]],
    ["operations manager", ["operations_support"]],
    ["chief of staff", ["operations_support"]],
    ["customer support in crypto", ["operations_support"]],
    ["brand designer", ["designer"]],
    ["solidity dev", ["engineer"]],
    // Українською
    ["ком'юніті менеджерка", ["community", "marketing_content"]],
    ["менеджер спільноти", ["community"]],
    ["модератор телеграм чату", ["community"]],
    ["маркетолог у web3", ["marketing_content"]],
    ["маркетінг в криптопроєкті", ["marketing_content"]],
    ["SMM-менеджер", ["marketing_content"]],
    ["контент-менеджер", ["marketing_content"]],
    ["піар менеджер", ["marketing_content"]],
    ["таргетолог", ["marketing_content"]],
    ["бізнес девелопер", ["bd"]],
    ["менеджер з продажів", ["bd"]],
    ["продакт менеджер", ["product_manager"]],
    ["проджект менеджер", ["product_manager"]],
    ["операційний менеджер", ["operations_support"]],
    ["девелопер", ["engineer"]],
    ["дизайнер інтерфейсів", ["designer"]],
    ["рекрутер", ["hr_recruiting"]],
    // Російською
    ["комьюнити менеджер", ["community", "marketing_content"]],
    ["менеджер по маркетингу", ["marketing_content"]],
    ["бизнес девелопер", ["bd"]],
    ["менеджер по продажам", ["bd"]],
    ["аккаунт менеджер", ["bd"]],
    ["контент мейкер", ["marketing_content"]],
    ["копирайтер", ["marketing_content"]],
    ["пиарщик", ["marketing_content"]],
  ] as const)("%s", (text, roles) => {
    expect(inferRoles(text)).toEqual(roles);
  });

  it("every example on step 1 gives a clear first role", () => {
    expect(TARGET_EXAMPLES.map((e) => inferRoles(e.text)[0])).toEqual(["bd", "engineer", "community"]);
  });

  it("never more than three", () => {
    expect(inferRoles("engineer, auditor, devrel, data analyst, trader, designer").length).toBe(3);
  });
});

describe("guessRoles: never nothing for a real brief", () => {
  it("gives the sure roles when there are some", () => {
    expect(guessRoles("BD lead at a DeFi protocol")).toEqual({ roles: ["bd"], confident: true });
  });

  it("gives three closest roles when no role is sure, weak words first", () => {
    expect(guessRoles("manager")).toEqual({ roles: ["product_manager", "bd", "operations_support"], confident: false });
    expect(guessRoles("менеджер у криптокомпанії")).toEqual({
      roles: ["product_manager", "bd", "operations_support"],
      confident: false,
    });
  });

  it("reads typos and transliteration as the closest role", () => {
    expect(guessRoles("markting at a protocol").roles[0]).toBe("marketing_content");
    expect(guessRoles("comunity manger").roles[0]).toBe("community");
    expect(guessRoles("developper").roles[0]).toBe("engineer");
    expect(guessRoles("tradr").roles[0]).toBe("trader");
    expect(guessRoles("markting").confident).toBe(false);
  });

  it("falls back to broad roles when the words say nothing, so the step still shows a guess", () => {
    expect(guessRoles("any job in crypto")).toEqual({ roles: [...DEFAULT_CLOSEST], confident: false });
    expect(guessRoles("I like cooking").roles).toHaveLength(3);
  });

  it("gives nothing for an empty brief", () => {
    expect(guessRoles("")).toEqual({ roles: [], confident: false });
    expect(guessRoles("   ")).toEqual({ roles: [], confident: false });
  });

  it("measures word similarity from 0 to 1", () => {
    expect(similarity("marketing", "marketing")).toBe(1);
    expect(similarity("markting", "marketing")).toBeCloseTo(8 / 9);
    expect(similarity("abc", "")).toBe(0);
  });
});

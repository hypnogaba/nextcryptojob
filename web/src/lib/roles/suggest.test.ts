import { describe, expect, it } from "vitest";
import { suggestRoles } from "./suggest";

describe("suggestRoles", () => {
  it.each([
    ["I write smart contracts in Solidity", "engineer"],
    ["Rust developer, backend", "engineer"],
    ["Smart contract auditor", "security_auditor"],
    ["Security research and bug bounties", "security_auditor"],
    ["DevRel or developer advocate at an L2", "devrel"],
    ["Onchain analyst, I build Dune dashboards", "data_research"],
    ["Product manager for a wallet", "product_manager"],
    ["PM at a DeFi protocol", "product_manager"],
    ["Project manager", "product_manager"],
    ["BD lead", "bd"],
    ["Partnerships and sales", "bd"],
    ["Growth marketing and content", "marketing_content"],
    ["KOL, I run a YouTube channel", "creator_kol"],
    ["Ambassador programs and creator stuff", "creator_kol"],
    ["Community manager and Discord moderator", "community"],
    ["Perps trader", "trader"],
    ["Market maker at a fund", "trader"],
    ["UI/UX designer, Figma", "designer"],
    ["Operations and customer success", "operations_support"],
    ["Treasury and accounting", "finance"],
    ["Compliance counsel", "legal_compliance"],
    ["Technical recruiter", "hr_recruiting"],
  ])("puts the obvious role first for %j", (text, role) => {
    expect(suggestRoles(text)[0]).toBe(role);
  });

  it.each([
    ["Шукаю роботу розробником смарт-контрактів", "engineer"],
    ["Ищу работу разработчиком на Rust", "engineer"],
    ["Аудит безпеки смарт-контрактів", "security_auditor"],
    ["Аналітик даних, Dune", "data_research"],
    ["Продакт менеджер", "product_manager"],
    ["Партнерства і продажі", "bd"],
    ["Маркетолог, контент", "marketing_content"],
    ["Блогер, ютуб", "creator_kol"],
    ["Ком’юніті менеджер, модератор", "community"],
    ["Трейдер", "trader"],
    ["Дизайнер інтерфейсів", "designer"],
    ["Юрист, комплаєнс", "legal_compliance"],
    ["Рекрутер", "hr_recruiting"],
  ])("understands Ukrainian and Russian: %j", (text, role) => {
    expect(suggestRoles(text)[0]).toBe(role);
  });

  it("returns at most three roles, strongest first", () => {
    const roles = suggestRoles("Solidity engineer who also does audits, trading, community and marketing");
    expect(roles).toHaveLength(3);
    expect(new Set(roles).size).toBe(3);
  });

  it("suggests nothing for empty or unrelated text", () => {
    expect(suggestRoles("")).toEqual([]);
    expect(suggestRoles("   ")).toEqual([]);
    expect(suggestRoles("anything interesting, really")).toEqual([]);
  });

  it("matches short words only as whole words", () => {
    // «pm» не в «npm», «bd» не в «abdul», «hr» не в «three», «ops» не в «devops».
    expect(suggestRoles("I maintain npm packages")).not.toContain("product_manager");
    expect(suggestRoles("Abdul here")).not.toContain("bd");
    expect(suggestRoles("three years")).not.toContain("hr_recruiting");
    expect(suggestRoles("devops")).toEqual(["engineer"]);
  });

  it("does not read marketing as market making, or the reverse", () => {
    expect(suggestRoles("marketing")).toEqual(["marketing_content"]);
    expect(suggestRoles("market making")).toEqual(["trader"]);
  });

  it("is deterministic", () => {
    const text = "research, data, community, product";
    expect(suggestRoles(text)).toEqual(suggestRoles(text));
  });
});

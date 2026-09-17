import { describe, expect, it } from "vitest";
import { isNonCryptoCompany } from "./clean.js";
import { isNonCryptoTitle, parseRoles, titleRoles } from "./roles.js";

describe("titleRoles: назва вакансії → наші ролі", () => {
  it.each([
    ["Senior Solidity Engineer", "engineer"],
    ["Smart Contract Developer", "engineer"],
    ["Staff Backend Engineer, Vaults", "engineer"],
    ["Smart Contract Auditor", "security_auditor"],
    ["Senior Penetration Tester (AWS)", "security_auditor"],
    ["Developer Relations Engineer", "devrel"],
    ["Senior Data Analyst", "data_research"],
    ["Senior Product Manager, Payments", "product_manager"],
    ["Technical Program Manager", "product_manager"],
    ["Business Development Manager, Cryptoassets", "bd"],
    ["Account Executive, Institutional Sales", "bd"],
    ["Head of Growth Marketing", "marketing_content"],
    ["Video Host & Producer", "creator_kol"],
    ["APAC Community Lead", "community"],
    ["Quantitative Trader - Crypto Market Making", "trader"],
    ["Senior Product Designer", "designer"],
    ["Customer Support Specialist", "operations_support"],
    ["Senior Accountant", "finance"],
    ["Senior Counsel", "legal_compliance"],
    ["Senior Technical Recruiter", "hr_recruiting"],
  ])("%s → %s", (title, role) => {
    expect(titleRoles(title)[0]).toBe(role);
  });

  it("головне слово назви перемагає доменне: інженер торгової платформи не трейдер", () => {
    expect(titleRoles("Senior Software Engineer, Trading Platform")).toEqual(["engineer"]);
    expect(titleRoles("Trading Analyst")).toContain("trader");
  });

  it("внутрішній аудит це фінанси, а не аудит смарт-контрактів", () => {
    expect(titleRoles("Head of Internal Audit")).not.toContain("security_auditor");
    expect(titleRoles("Head of Internal Audit")).toContain("finance");
  });

  it("продакт-дизайнер і продакт-маркетинг не стають продакт-менеджером", () => {
    expect(titleRoles("Senior Product Designer")).not.toContain("product_manager");
    expect(titleRoles("Product Marketing Manager")).not.toContain("product_manager");
  });

  it("інженер з безпеки підходить і аудитору, і інженеру", () => {
    expect(titleRoles("Protocol Security Engineer")).toEqual(expect.arrayContaining(["engineer", "security_auditor"]));
  });

  it("тег підштовхує роль лише коли вона вже є в назві", () => {
    expect(titleRoles("Associate", ["web3", "engineering"])).toEqual([]);
  });

  it("не-крипто назви з тегом web3 відкидаються (живий кеш попереднього проєкту 12.09)", () => {
    for (const t of [
      "Expert Audio Transcriber, Afrikaans", "Freelance Transcriptionist - Welsh", "Robata Chef",
      "001-09-2026/GD-RDC/CUISINIER -GOMA", "Mechanical Engineer - HVAC & Plumbing", "Electrical Engineer",
      "Data Center Operations Engineer", "Repair Technician", "General Application", "Join Our Talent Community",
    ]) {
      expect(isNonCryptoTitle(t), t).toBe(true);
      expect(titleRoles(t, ["web3"]), t).toEqual([]);
    }
  });

  it("не плутає корисні назви з не-крипто: драйвер пристрою, роздрібна торгівля на біржі", () => {
    expect(isNonCryptoTitle("Linux Kernel Driver Developer")).toBe(false);
    expect(isNonCryptoTitle("Retail Trading Product Manager")).toBe(false);
  });

  it("назва без жодної нашої ролі дає []", () => {
    expect(titleRoles("Associate")).toEqual([]);
    expect(titleRoles("")).toEqual([]);
    expect(titleRoles("Director of Power Infrastructure")).toEqual([]);
  });

  it("той самий словник, що й підказка ролей на сайті: українська назва теж працює", () => {
    expect(titleRoles("Розробник смарт-контрактів")).toContain("engineer");
  });
});

describe("чистка компаній", () => {
  it("відомі не-крипто компанії з тегом web3 відкидаються за company_key і за назвою", () => {
    expect(isNonCryptoCompany("perle")).toBe(true);
    expect(isNonCryptoCompany(null, "Ping Identity, Inc.")).toBe(true);
    expect(isNonCryptoCompany("coinbase", "Coinbase")).toBe(false);
  });
});

describe("parseRoles", () => {
  it("лише відомі ключі, без повторів, у порядку запису", () => {
    expect(parseRoles('["trader","nope","trader","engineer"]')).toEqual(["trader", "engineer"]);
    expect(parseRoles("not json")).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
  });
});

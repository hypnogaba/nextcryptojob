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

describe("titleRoles: назви, що до огляду 08.10 не діставали ролі", () => {
  it.each([
    ["Head of GTM", "bd"],
    ["USAT Institutional Associate", "bd"],
    ["Account Director, Crypto", "bd"],
    ["Head of Tokenization", "bd"],
    ["Paid Media Specialist", "marketing_content"],
    ["Online Media Buyer (10Bet)", "marketing_content"],
    ["PR Manager, Pakistan", "marketing_content"],
    ["CRM and Lifecycle Manager II", "marketing_content"],
    ["People Business Partner", "hr_recruiting"],
    ["People & Culture Associate", "hr_recruiting"],
    ["Money Laundering Reporting Officer, ADGM", "legal_compliance"],
    ["Data Protection Officer", "legal_compliance"],
    ["Head of US Government Affairs", "legal_compliance"],
    ["Concierge Specialist IV", "operations_support"],
    ["Client Success Manager", "operations_support"],
    ["Implementation Manager", "operations_support"],
    ["Treausry Associate", "finance"],
    ["Chief Technology Officer", "engineer"],
    ["FPGA Intern", "engineer"],
    ["Specialist, CSIRT", "security_auditor"],
    ["Product Director, VIP Products", "product_manager"],
    ["Research Intern", "data_research"],
    ["Creative Producer", "creator_kol"],
  ] as const)("%s → %s", (title, role) => {
    expect(titleRoles(title)).toContain(role);
  });

  it.each([
    ["数据分析师（无障碍纯英文沟通）", "data_research"],
    ["Web3 研发工程师（资深）— 钱包方向", "engineer"],
    ["交易引擎核心开发", "engineer"],
    ["ソフトウェアエンジニア｜規制対応オンチェーン金融基盤", "engineer"],
    ["QAリード | 規制対応オンチェーン金融基盤", "engineer"],
    ["事業開発／プロジェクトマネージャー（オンチェーン金融）", "bd"],
    ["测试负责人", "engineer"],
  ] as const)("китайська й японська: %s → %s", (title, role) => {
    expect(titleRoles(title)).toContain(role);
  });

  it("does not take a domain word or a business title for engineering", () => {
    expect(titleRoles("Corporate Development Lead")).toEqual(["bd"]);
    expect(titleRoles("Account Executive, Domain Name Inventory")).toContain("bd");
    expect(titleRoles("Crypto Inventory Operations Intern")).toContain("operations_support");
  });

  it("keeps quant and analyst roles on a risk title", () => {
    const roles = titleRoles("Quantitative Risk Analyst — Derivatives & Clearing");
    expect(roles).toContain("finance");
    expect(roles.length).toBeGreaterThan(0);
  });

  it.each([
    "Sr. Director, Site Development – Texas",
    "Onsite Generation & Power Origination Associate",
    "Superintendent, Mechanical",
    "Senior Power Strategist - Load",
    "Transmission & Interconnection, Principal",
  ])("mining sites and power are not our audience: %s", (title) => {
    expect(isNonCryptoTitle(title)).toBe(true);
    expect(titleRoles(title)).toEqual([]);
  });
});

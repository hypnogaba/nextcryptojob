import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, type SessionMethod } from "@/lib/auth/session";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { addEmailAction } from "../account/email-actions";
import { saveDeliveryAction } from "./actions/delivery";
import WelcomePage from "./page";

const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

type User = { email?: string | null; telegram?: string | null; step?: string | null; target?: string; roles?: string };

async function signIn(u: User, method: SessionMethod | null = null) {
  exec(
    "INSERT INTO users (id, email, telegram_id, channel, onboarding_step, target_text, roles) VALUES ('u', ?, ?, ?, ?, ?, ?)",
    u.email === undefined ? "ada@example.com" : u.email,
    u.telegram ?? null,
    u.telegram ? "telegram" : "email",
    u.step ?? null,
    u.target ?? null,
    u.roles ?? "[]",
  );
  if (u.step && ["x", "wallets", "sources", "done"].includes(u.step)) {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
  }
  await createSession("u", method);
}

const render = async (step?: string) => renderToStaticMarkup(await WelcomePage({ searchParams: Promise.resolve({ step }) }));

let outbox: { text: string }[] = [];
beforeEach(() => {
  outbox = [];
  revalidated.length = 0;
  resetHarness({ EMAIL: { send: async (m: { text: string }) => (outbox.push(m), { messageId: "m" }) } as unknown as SendEmail });
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe("step 1: an example of how much to write", () => {
  it("lists what to include, gives clickable examples and a length hint", async () => {
    await signIn({ step: "target" });
    const html = await render();
    expect(html).toContain("What to include");
    expect(html).toContain("The pay you want, a month or a year");
    expect(html).toContain("Or start from an example");
    expect(html).toContain("BD lead at a DeFi protocol, remote, from 3,000 EUR a month.");
    expect(html).toContain("Aim for 60 to 400 characters");
  });
});

describe("roles: our guess from step 1", () => {
  it("shows the roles read from the words as chosen chips, with the rest to add, and no 'coming soon' group", async () => {
    await signIn({ step: "roles", target: "BD lead at a DeFi protocol, I closed 20+ partnerships" });
    const html = await render();
    expect(html).toContain("We think you are looking for:");
    expect(html).toContain('<input type="hidden" name="role" value="bd"/>');
    expect(html).not.toContain('name="role" value="engineer"');
    expect(html).toContain("+</span>Engineer");
    expect(html).toContain("My role is not in the list");
    expect(html).not.toContain("Score coming soon");
    expect(html).not.toContain("Scored now");
  });

  it("when no role is sure, suggests the closest ones instead of nothing, and says it is a guess", async () => {
    await signIn({ step: "roles", target: "I like cooking" });
    const html = await render();
    expect(html).toContain("We are not sure of your role. These are the closest to your words:");
    expect(html).toContain('<input type="hidden" name="role" value="marketing_content"/>');
    expect(html).toContain("Yes, continue");
  });

  it("reads a Ukrainian community manager brief as community and marketing", async () => {
    await signIn({ step: "roles", target: "комуніті менеджерка, Лісабон або віддалено" });
    const html = await render();
    expect(html).toContain("We think you are looking for:");
    expect(html).toContain('<input type="hidden" name="role" value="community"/>');
    expect(html).toContain('<input type="hidden" name="role" value="marketing_content"/>');
  });
});

describe("place: filled in from step 1", () => {
  it("prefills remote and a yearly salary from 'from 3,000 EUR a month'", async () => {
    await signIn({ step: "place", target: "BD lead, remote, from 3,000 EUR a month", roles: '["bd"]' });
    const html = await render();
    expect(html).toContain("We filled this in from your words.");
    expect(html).toMatch(/checked="" value="remote"/);
    expect(html).toContain('value="36000"');
    expect(html).toMatch(/<option value="EUR" selected="">/);
  });
});

describe("channel step: no dead email option", () => {
  it("a Telegram sign-in without email sees Telegram chosen and can add an email right here", async () => {
    await signIn({ email: null, telegram: "777", step: "delivery", roles: '["bd"]' }, "telegram");
    const html = await render();
    expect(html).not.toContain('value="email"');
    expect(html).toMatch(/checked="" value="telegram"/);
    expect(html).toContain("Add an email");
    expect(html).toContain("Send code");
    expect(html).not.toContain("Add an email above to use this.");
  });

  it("adding the email right on the step makes Email appear there, and it can be chosen at once", async () => {
    await signIn({ email: null, telegram: "777", step: "delivery", roles: '["bd"]' }, "telegram");
    await addEmailAction({ step: "email", email: "" }, form({ intent: "send", email: "ada@example.com" }));
    const code = outbox.at(-1)!.text.match(/(\d{6})/)![1];
    await expect(
      addEmailAction({ step: "code", email: "ada@example.com" }, form({ intent: "verify", email: "ada@example.com", code })),
    ).resolves.toMatchObject({ step: "done" });
    expect(revalidated).toContain("/welcome");

    const html = await render();
    expect(html).toContain('value="email"');
    expect(html).toContain("ada@example.com");
    expect(html).not.toContain("Send code");
    await expect(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "UTC" })).catch((e: Error) => e.message)).resolves.toBe(
      "redirect(/welcome?step=consent)",
    );
    expect(rows("SELECT channel, onboarding_step FROM users")).toEqual([{ channel: "email", onboarding_step: "consent" }]);
  });

  it("with an email and no Telegram, shows only Email and a pointer to connect Telegram later", async () => {
    await signIn({ step: "delivery", roles: '["bd"]' }, "email");
    const html = await render();
    expect(html).toMatch(/checked="" value="email"/);
    expect(html).not.toContain('value="telegram"');
    expect(html).not.toContain("Send code");
    expect(html).toContain("Prefer Telegram?");
  });
});

describe("X step", () => {
  it("is required: no 'Skip for now', no code to put in the bio", async () => {
    await signIn({ step: "x", roles: '["bd"]' });
    const html = await render();
    expect(html).toContain("Required to continue.");
    expect(html).toContain("No code and no sign-in with X");
    expect(html).not.toContain("Skip for now");
    expect(html).not.toContain("Copy code");
  });

  it("someone who reached wallets without X under the old order is sent to X first", async () => {
    await signIn({ step: "wallets", roles: '["bd"]' });
    expect(await render("wallets")).toContain("Your X account");
  });
});

describe("wallets and sources: optional, each one raises the score, no Sherlock", () => {
  it("wallets say up to 10 and that each raises the score", async () => {
    await signIn({ step: "wallets", roles: '["bd"]' });
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    const html = await render();
    expect(html).toContain("each wallet raises your score. Add up to 10");
    expect(html).toContain("0 of 10 wallets");
    expect(html).toContain("Skip for now");
  });

  it("sources have GitHub, YouTube and a website, and no Sherlock", async () => {
    await signIn({ step: "sources", roles: '["bd"]' });
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    const html = await render();
    expect(html).toContain("each one raises your score");
    expect(html).toContain('id="github"');
    expect(html).not.toMatch(/sherlock/i);
    expect(html).not.toContain("Verify your GitHub");
  });
});

describe("admin", () => {
  it("an admin signed in by email is told the setup is optional, with a link to /admin", async () => {
    await signIn({ email: "hypnogaba@gmail.com", step: null }, "email");
    const html = await render();
    expect(html).toContain("You are signed in as an admin. This setup is optional for you.");
    expect(html).toContain('href="/admin"');
  });

  it("the same account signed in by Telegram is not", async () => {
    await signIn({ email: "hypnogaba@gmail.com", step: null }, "telegram");
    expect(await render()).not.toContain("signed in as an admin");
  });

  it("a person with another email is not", async () => {
    await signIn({ email: "ada@example.com", step: null }, "email");
    expect(await render()).not.toContain("signed in as an admin");
  });
});

describe("consent step: companies block (owner 14.09)", () => {
  it("first pass: a visible, pre-ticked box with the plain text, and the after-approval option unticked", async () => {
    await signIn({ step: "consent", roles: '["engineer"]' });
    const html = await render("consent");
    expect(html).toContain("data-sharing");
    expect(html).toMatch(/<input type="checkbox"[^>]*name="visible" checked=""/);
    expect(html).toContain(
      "Companies hiring on NextCryptoJob can find you and see your score and Telegram handle. You can turn this off any time in Settings.",
    );
    expect(html).toContain("Only after I approve each company");
    expect(html).not.toMatch(/name="approval_only"[^>]*checked=""/);
    // Без ніка в Telegram: пояснення, що компанія спершу попросить знайомство, пошта прихована.
    expect(html).toContain("You have no Telegram username yet");
  });

  it("shows the handle a company will see when there is one", async () => {
    await signIn({ step: "consent", roles: '["engineer"]', telegram: "42" });
    exec("UPDATE users SET telegram_username = 'ada_eth' WHERE id = 'u'");
    expect(await render("consent")).toContain("Companies see @ada_eth.");
  });

  it("editing after the brief does not show the block and points to Settings", async () => {
    await signIn({ step: "done", roles: '["engineer"]' });
    const html = await render("consent");
    expect(html).not.toContain("data-sharing");
    expect(html).toContain('href="/settings#companies-title"');
  });
});

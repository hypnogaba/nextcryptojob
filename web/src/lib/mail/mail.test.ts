import { afterEach, describe, expect, it, vi } from "vitest";
import { getMailer } from "./index";
import { logMailer } from "./log";
import { loginCodeEmail } from "./login-code";

const MESSAGE = { to: "ada@example.com", subject: "s", text: "t", html: "<p>t</p>" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("logMailer", () => {
  it("prints the email to the server log in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await logMailer.send(MESSAGE);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("to=ada@example.com"));
  });

  it("refuses in production and prints nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(logMailer.send(MESSAGE)).rejects.toThrow(/disabled in production/);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("getMailer", () => {
  const binding = { send: vi.fn(async () => ({ messageId: "m1" })) } as unknown as SendEmail;

  it("uses Cloudflare Email Service when the binding exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const mailer = getMailer({ EMAIL: binding });
    expect(mailer).not.toBeNull();
    await mailer!.send(MESSAGE);
    expect(binding.send).toHaveBeenCalledWith({
      from: { email: "login@nextcryptojob.xyz", name: "NextCryptoJob" },
      to: "ada@example.com",
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
  });

  it("falls back to the log in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getMailer({})).toBe(logMailer);
  });

  it("gives nothing in production without the binding", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getMailer({})).toBeNull();
  });
});

describe("loginCodeEmail", () => {
  it("puts the code in the subject and says when it expires", () => {
    const mail = loginCodeEmail("042917", 10);
    expect(mail.subject).toBe("Your NextCryptoJob code: 042917");
    expect(mail.text).toBe(
      "Your NextCryptoJob sign-in code is 042917.\n\nIt expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.\n",
    );
    expect(mail.html).toContain("042917");
    expect(mail.html).toContain("It expires in 10 minutes.");
  });
});

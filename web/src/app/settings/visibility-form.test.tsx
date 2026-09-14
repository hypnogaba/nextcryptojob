import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VisibilityForm } from "./visibility-form";

vi.mock("./actions", () => ({ setVisibilityAction: async () => ({}), setContactModeAction: async () => ({}) }));

const DIRECT = { mode: "direct" as const, telegramHandle: "ada" };
const APPROVAL = { mode: "approval" as const, telegramHandle: "ada" };

describe("Show me to companies panel", () => {
  it("off: its own grey background, the state in words, what companies see and never see, a clear button", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible={false} canTurnOn contact={APPROVAL} />);
    expect(html).toContain('data-visible="off"');
    expect(html).toContain("bg-wash");
    expect(html).toContain("You are hidden from companies");
    expect(html).toContain("When you are visible, companies see");
    expect(html).toContain("They never see");
    expect(html).toContain("Your wallet addresses");
    expect(html).toMatch(/type="submit"[^>]*>Show me to companies</);
  });

  it("on: a different, brand background and the opposite button", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible canTurnOn contact={DIRECT} />);
    expect(html).toContain('data-visible="on"');
    expect(html).toContain("bg-brand-soft");
    expect(html).toContain("You are visible to companies");
    expect(html).toContain("Hide me from companies");
  });

  it("without a score yet it cannot be turned on, and says why", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible={false} canTurnOn={false} contact={APPROVAL} />);
    expect(html).toContain("You need a score first.");
    expect(html).not.toMatch(/>Show me to companies<\/button>/);
  });

  it("shows the second switch, Show my Telegram directly, with its state in words", () => {
    const on = renderToStaticMarkup(<VisibilityForm visible canTurnOn contact={DIRECT} />);
    expect(on).toContain("Show my Telegram directly");
    expect(on).toContain('data-contact-mode="direct"');
    expect(on).toContain("Your Telegram @ada is shown");
    expect(on.match(/role="switch"/g)).toHaveLength(2);
    // Натискання вимикає direct і повертає до «after approval».
    expect(on).toMatch(/name="mode" value="approval"/);

    const off = renderToStaticMarkup(<VisibilityForm visible canTurnOn contact={APPROVAL} />);
    expect(off).toContain("Companies ask you first");
    expect(off).toMatch(/name="mode" value="direct"/);
  });

  it("direct without a Telegram username says companies ask first and the email stays hidden", () => {
    const html = renderToStaticMarkup(
      <VisibilityForm visible canTurnOn contact={{ mode: "direct", telegramHandle: null }} />,
    );
    expect(html).toContain("You have no Telegram username yet");
    expect(html).toContain("We never show your email without your yes.");
  });
});

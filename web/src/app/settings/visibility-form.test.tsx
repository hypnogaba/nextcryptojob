import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VisibilityForm } from "./visibility-form";

vi.mock("./actions", () => ({ setVisibilityAction: async () => ({}) }));

describe("Show me to companies panel", () => {
  it("off: its own grey background, the state in words, what companies see and never see, a clear button", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible={false} canTurnOn />);
    expect(html).toContain('data-visible="off"');
    expect(html).toContain("bg-wash");
    expect(html).toContain("You are hidden from companies");
    expect(html).toContain("When you are visible, companies see");
    expect(html).toContain("They never see");
    expect(html).toContain("Your wallet addresses");
    expect(html).toMatch(/type="submit"[^>]*>Show me to companies</);
  });

  it("on: a different, brand background and the opposite button", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible canTurnOn />);
    expect(html).toContain('data-visible="on"');
    expect(html).toContain("bg-brand-soft");
    expect(html).toContain("You are visible to companies");
    expect(html).toContain("Hide me from companies");
  });

  it("without a score yet it cannot be turned on, and says why", () => {
    const html = renderToStaticMarkup(<VisibilityForm visible={false} canTurnOn={false} />);
    expect(html).toContain("You need a score first.");
    expect(html).not.toMatch(/>Show me to companies<\/button>/);
  });
});

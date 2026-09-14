import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AddEmailState } from "./email-actions";

/** useActionState тут просто повертає стан, який тест поклав нижче: форма сама лише малює крок. */
let mockState: AddEmailState = { step: "email", email: "" };
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useActionState: (action: unknown) => [mockState, action] };
});
vi.mock("./email-actions", () => ({ addEmailAction: async () => mockState }));

const { AddEmailForm } = await import("./add-email-form");

describe("AddEmailForm: merge step", () => {
  it("offers to merge, with the offer text and a Merge accounts button", () => {
    mockState = {
      step: "merge",
      email: "ada@example.com",
      grant: "1234.abcd",
      message: { tone: "info", text: "This email is already on your other NextCryptoJob account. Merge them." },
    };
    const html = renderToStaticMarkup(<AddEmailForm />);
    expect(html).toContain("This email is already on your other NextCryptoJob account");
    expect(html).toMatch(/name="email"[^>]*value="ada@example\.com"/);
    expect(html).toMatch(/name="grant"[^>]*value="1234\.abcd"/);
    expect(html).toMatch(/value="merge"[^>]*name="intent"[^>]*>Merge accounts</);
    expect(html).toContain("Use a different email");
  });

  it("shows the success message and no form once merged", () => {
    mockState = { step: "done", email: "ada@example.com", message: { tone: "success", text: "Accounts merged." } };
    const html = renderToStaticMarkup(<AddEmailForm />);
    expect(html).toContain("Accounts merged.");
    expect(html).not.toContain("<form");
  });

  it("still shows the plain email step when there is nothing to merge", () => {
    mockState = { step: "email", email: "" };
    const html = renderToStaticMarkup(<AddEmailForm />);
    expect(html).toContain("Add an email");
    expect(html).not.toContain("Merge accounts");
  });
});

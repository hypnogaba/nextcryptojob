import type { Metadata } from "next";
import { ContactForm } from "./contact-form";

export const metadata: Metadata = {
  title: "Contact | NextCryptoJob",
  description: "Reach the NextCryptoJob team: candidates, companies or press.",
};

const EMAIL = "hello@nextcryptojob.xyz";

export default function ContactPage() {
  return (
    <section className="mx-auto max-w-2xl px-[clamp(16px,4vw,32px)] pt-10 pb-24 sm:pt-16">
      <h1 className="display text-title">Contact</h1>
      <p className="mt-3 text-lg text-ink-muted">
        Write to us at{" "}
        <a href={`mailto:${EMAIL}`} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          {EMAIL}
        </a>{" "}
        or use the form below. A real person reads every message.
      </p>
      <div className="mt-8 border-t border-line pt-8">
        <ContactForm />
      </div>
    </section>
  );
}

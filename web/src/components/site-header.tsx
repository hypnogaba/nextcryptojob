import { HeaderAuthLink } from "@/components/header-auth-link";
import { Wordmark } from "@/components/wordmark";

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Wordmark />
        <HeaderAuthLink />
      </div>
    </header>
  );
}

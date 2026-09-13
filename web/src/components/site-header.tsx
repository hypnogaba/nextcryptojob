import { HeaderNav } from "@/components/header-auth-link";
import { Wordmark } from "@/components/wordmark";

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex min-h-16 max-w-[1240px] items-center justify-between gap-4 px-[clamp(16px,4vw,56px)]">
        <Wordmark />
        <nav aria-label="Main" className="flex items-center gap-1 lg:gap-3">
          <HeaderNav />
        </nav>
      </div>
    </header>
  );
}

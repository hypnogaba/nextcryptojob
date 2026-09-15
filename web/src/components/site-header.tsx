import { HeaderNav } from "@/components/header-auth-link";
import { Wordmark } from "@/components/wordmark";

export function SiteHeader() {
  return (
    <header>
      <div className="mx-auto flex h-[72px] max-w-[1280px] items-center justify-between gap-3 px-[clamp(16px,4vw,32px)]">
        <Wordmark />
        <HeaderNav />
      </div>
    </header>
  );
}

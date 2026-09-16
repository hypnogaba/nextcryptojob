import { currentUser } from "@/lib/auth/session";
import { renderProfilePdf } from "@/lib/card/pdf";
import { profileView } from "@/lib/card/profile";
import { applyUrl, loadProfileInput, unlocks } from "@/lib/card/profile-load";
import { appEnv } from "@/lib/db";
import { siteOrigin } from "@/lib/site";
import { loadCardView } from "../card-data";

// PDF профілю-доказу (/c/<код>/profile.pdf). Лише з ключем ?k= поточної версії або для власника
// в його сесії; інакше 404, як і для картки, якої немає: без підказки, що файл існує.

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const env = appEnv();
  const loaded = await loadProfileInput(env.DB, slug, new Date());
  if (!loaded) return NOT_FOUND();
  const key = new URL(req.url).searchParams.get("k");
  const allowed = (await unlocks(env.SESSION_SECRET, loaded, key)) || (await currentUser())?.id === loaded.userId;
  if (!allowed) return NOT_FOUND();
  const card = await loadCardView(slug);
  if (!card) return NOT_FOUND();

  const origin = siteOrigin(env);
  const verify = (await applyUrl(env.SESSION_SECRET, origin, slug, loaded)) ?? `${origin}/c/${slug}`;
  const pdf = await renderProfilePdf(
    {
      displayName: card.displayName,
      roleName: card.roleName,
      score: card.score,
      level: card.level,
      formulaVersion: card.formulaVersion,
      issuedOn: card.issuedOn,
      back: card.back,
    },
    profileView(loaded.input, "full"),
    verify,
  );
  return new Response(pdf as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="nextcryptojob-${slug}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  });
}

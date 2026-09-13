import { renderCardImage } from "@/lib/card/og";
import { loadCardView } from "./card-data";

// Картинка картки для посилань у X і Open Graph (/c/<slug>/opengraph-image).
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "NextCryptoJob score card";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const view = await loadCardView(slug);
  if (!view) return new Response("Card not found", { status: 404 });
  return renderCardImage(view, "link");
}

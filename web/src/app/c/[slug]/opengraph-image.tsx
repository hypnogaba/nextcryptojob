import { renderCardImage } from "@/lib/card/og";
import { cardView } from "@/lib/card/view";
import { loadCard } from "./card-data";

// Картинка картки для X і Open Graph (/c/<slug>/opengraph-image).
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "NextCryptoJob score card";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const card = await loadCard(slug);
  if (!card) return new Response("Card not found", { status: 404 });
  return renderCardImage(cardView(card));
}

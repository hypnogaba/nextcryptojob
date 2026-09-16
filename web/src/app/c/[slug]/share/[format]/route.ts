import { renderCardImage, type ShareFormat } from "@/lib/card/og";
import { loadCardView } from "../../card-data";

// Картинки для допису в X: /c/<slug>/share/square (1200×1200, основна після напряму D),
// /c/<slug>/share/wide (1200×675) і /c/<slug>/share/tall (1080×1350).
const FORMATS: Partial<Record<string, { format: ShareFormat; name: string }>> = {
  square: { format: "square", name: "1x1" },
  wide: { format: "wide", name: "16x9" },
  tall: { format: "tall", name: "4x5" },
};

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; format: string }> }) {
  const { slug, format } = await params;
  const spec = FORMATS[format];
  if (!spec) return new Response("Not found", { status: 404 });
  const view = await loadCardView(slug);
  if (!view) return new Response("Card not found", { status: 404 });
  const res = renderCardImage(view, spec.format);
  res.headers.set("content-disposition", `inline; filename="nextcryptojob-${slug}-${spec.name}.png"`);
  return res;
}

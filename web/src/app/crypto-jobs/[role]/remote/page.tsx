import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { categoryBySlug } from "@/lib/jobs/categories";
import { CategoryPage, categoryMetadata } from "../../category-page";
import { loadCategoryIndex } from "../../data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ role: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = categoryBySlug((await params).role);
  if (!c) return { title: "Not found", robots: { index: false, follow: false } };
  return categoryMetadata(c, true, await loadCategoryIndex());
}

export default async function CryptoJobsRemotePage({ params }: Props) {
  const c = categoryBySlug((await params).role);
  if (!c) notFound();
  return <CategoryPage c={c} remote index={await loadCategoryIndex()} />;
}

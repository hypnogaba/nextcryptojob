import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { categoryBySlug } from "@/lib/jobs/categories";
import { CategoryPage, categoryMetadata } from "../category-page";
import { loadCategoryIndex } from "../data";

// Живі вакансії з кешу краю (lib/jobs/categories.ts): на збірці бази нема, тож на запит.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ role: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = categoryBySlug((await params).role);
  if (!c) return { title: "Not found", robots: { index: false, follow: false } };
  return categoryMetadata(c, false, await loadCategoryIndex());
}

export default async function CryptoJobsRolePage({ params }: Props) {
  const c = categoryBySlug((await params).role);
  if (!c) notFound();
  return <CategoryPage c={c} remote={false} index={await loadCategoryIndex()} />;
}

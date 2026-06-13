import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findPack, findCategory } from '../packs-data';
import { getPackDetail, getRecentPulls } from '@/lib/data/packs';
import PackDetailClient from './PackDetailClient';

// Pack detail is backend-driven (Top Hits + Pull Odds via GET /store/packs/:slug),
// so render per request — keeps odds fresh and frees the build from a live
// backend (the fetch degrades to mock pools when unreachable).
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const pack = findPack(slug);
  return {
    title: pack
      ? `${pack.name} — ${pack.categoryName} | Pokenic`
      : 'Pack | Pokenic',
  };
}

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const pack = findPack(slug);
  const category = findCategory(slug);
  if (!pack || !category) notFound();

  // Base pack art/price/siblings stay static (packs-data); the gacha depth
  // (Top Hits + Pull Odds) and the live Recent Pulls feed come from the backend.
  // Fetch both in parallel — independent reads, no waterfall — each degrading on
  // its own (detail → null → mock pools; recent pulls → [] → empty state).
  const [detail, recentPulls] = await Promise.all([
    getPackDetail(slug),
    getRecentPulls(),
  ]);

  return (
    <PackDetailClient
      pack={pack}
      siblings={category.packs}
      detail={detail}
      recentPulls={recentPulls}
    />
  );
}

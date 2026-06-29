import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findPack } from '../packs-data';
import { getPackBySlug, getPackDetail, getRecentPulls } from '@/lib/data/packs';
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
      ? `${pack.name} — ${pack.categoryName}`
      : 'Pack',
  };
}

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Resolve the base pack from the SAME backend catalog seam as the /claw list
  // (getPackBySlug → getPackCategories), so admin-created packs that appear in
  // the grid also resolve here instead of 404ing against the static 8-pack list.
  // The gacha depth (Top Hits + Pull Odds) and the live Recent Pulls feed come
  // from their own routes. All three fetch in parallel — independent reads, no
  // waterfall — each degrading on its own (base → null → notFound; detail →
  // null → mock pools; recent pulls → [] → empty state).
  const [base, detail, recentPulls] = await Promise.all([
    getPackBySlug(slug),
    getPackDetail(slug),
    getRecentPulls(),
  ]);
  if (!base) notFound();

  return (
    <PackDetailClient
      pack={base.pack}
      siblings={base.siblings}
      detail={detail}
      recentPulls={recentPulls}
    />
  );
}

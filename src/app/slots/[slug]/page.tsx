// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPackBySlug, getPackDetail, getRecentPulls } from '@/lib/data/packs';
import PackDetailClient from './PackDetailClient';

// The /slots pack detail — configurator/Top-Hits/odds; the "Open Pack" CTA
// launches the slot-machine reel (./spin). Backend-driven (catalog + gacha
// depth + live recent pulls), so render per request — each read degrades on
// its own (base → notFound; detail → empty gacha depth; pulls → empty).
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Backend catalog (source of truth) — a backend-created pack gets a real
  // title too, not just the baked 8. Next dedupes the fetch with the page body.
  const base = await getPackBySlug(slug);
  return {
    title: base ? `${base.pack.name} — ${base.pack.categoryName}` : 'Pack',
  };
}

export default async function SlotsPackDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
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

// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findPack } from '@/app/claw/packs-data';
import { getPackBySlug, getPackDetail, getRecentPulls } from '@/lib/data/packs';
import PackDetailClient from '@/app/claw/[slug]/PackDetailClient';

// The /slots pack detail — the SAME configurator/Top-Hits/odds layout as
// /claw/[slug], but rendered in mode="slots" so its "Open Pack" CTA launches the
// slot-machine reel (./spin) instead of the in-place overlay. Backend-driven
// (catalog + gacha depth + live recent pulls), so render per request — each read
// degrades on its own (base → notFound; detail → mock pools; pulls → empty).
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
      mode="slots"
      pack={base.pack}
      siblings={base.siblings}
      detail={detail}
      recentPulls={recentPulls}
    />
  );
}

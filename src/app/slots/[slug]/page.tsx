// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPackBySlug, getPackDetail, getRecentPulls } from '@/lib/data/packs';
import { canClaimFreePack, getFreePackState } from '@/lib/data/free-pack';
import { FREE_WELCOME_CATEGORY } from '@/lib/packs-data';
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
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ count?: string }>;
}) {
  const { slug } = await params;
  const { count: countRaw } = await searchParams;
  const parsed = Number(countRaw);
  const count = Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : 1;
  const [base, detail, recentPulls] = await Promise.all([
    getPackBySlug(slug),
    getPackDetail(slug),
    // This pack's own history — the feed used to be global, so every pack
    // showed identical rows.
    getRecentPulls(slug),
  ]);
  if (!base) notFound();

  // The free welcome pack is hidden from the catalog but NOT from this route, so
  // a shared link / history entry / stale badge lands an ineligible account on a
  // page that would otherwise promise a gift the backend then refuses at the
  // reel. One extra read, and only for that one pack.
  //
  // A rendered free pack is always the ACTIVE one (/store/packs/:slug 404s
  // inactive packs, so this page would not exist otherwise), which is why a
  // guest reliably lands on `signup` here rather than `hidden`. The state →
  // eligibility mapping, including that guest case, is unit-tested in
  // lib/data/__tests__/free-pack-state.test.ts.
  const freePackEligible =
    base.pack.categoryId === FREE_WELCOME_CATEGORY
      ? canClaimFreePack(await getFreePackState(), slug)
      : undefined;

  return (
    <PackDetailClient
      pack={base.pack}
      siblings={base.siblings}
      detail={detail}
      recentPulls={recentPulls}
      initialQty={count}
      freePackEligible={freePackEligible}
    />
  );
}

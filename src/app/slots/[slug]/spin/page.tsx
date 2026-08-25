// src/app/slots/[slug]/spin/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPackBySlug, getPackDetail, getRecentPulls } from '@/lib/data/packs';
import SlotMachineClient from '../SlotMachineClient';

// The slot-machine reel — reached from the pack detail (/slots/[slug]) "Open Pack"
// CTA with ?count=N. The reel performs the single charge (openBatch) on spin.
// Backend-driven (catalog + live recent pulls), render per request — same seam as
// the detail above.
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Backend catalog (source of truth), same as the sibling detail page — a
  // backend-created pack gets a real title. Next dedupes the fetch with the body.
  const base = await getPackBySlug(slug);
  return {
    title: base ? `${base.pack.name} — Slot Machine` : 'Slot Machine',
  };
}

export default async function SlotSpinPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ count?: string; demo?: string; freeRip?: string }>;
}) {
  const { slug } = await params;
  const { count: countRaw, demo, freeRip } = await searchParams;
  const parsed = Number(countRaw);
  const count = Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : 1;
  const [base, detail, recentPulls] = await Promise.all([
    getPackBySlug(slug),
    getPackDetail(slug),
    // Scoped to this pack, same as the detail page above.
    getRecentPulls(slug),
  ]);
  if (!base) notFound();

  return (
    <SlotMachineClient
      pack={base.pack}
      recentPulls={recentPulls}
      count={count}
      publishedOdds={detail?.publishedOdds ?? null}
      // The reel flickers ONLY these cards' Pokémon (decoys tied to a reward),
      // never arbitrary species. Available for real spins too, not just demo.
      pool={detail?.pool ?? []}
      // ?demo=1 → guest demo mode: the reel samples client-side from the public
      // pool (no backend open, no charge, nothing won). Logged-in visitors are
      // ignored by the client (they always get the real, auth-gated machine).
      demoPool={demo === '1' ? (detail?.pool ?? []) : null}
      // A task's free-rip entitlement. The machine spends THIS instead of
      // charging; the claim already recorded it, so a player who never arrives
      // (or bails before spinning) still has it waiting on /task.
      freeRipClaimId={
        typeof freeRip === 'string' && freeRip.trim() !== '' ? freeRip : null
      }
      // The demo draw rolls odds SET 3's real tier split (aggregated backend-
      // side), not the marketing published odds — display is unaffected. Gated
      // like demoPool above: only the demo reads it, so only the demo gets it.
      demoOdds={demo === '1' ? (detail?.demoOdds ?? null) : null}
    />
  );
}

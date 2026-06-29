// src/app/slots/[slug]/spin/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findPack } from '@/app/claw/packs-data';
import { getPackBySlug, getRecentPulls } from '@/lib/data/packs';
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
  const pack = findPack(slug);
  return {
    title: pack
      ? `${pack.name} — Slot Machine`
      : 'Slot Machine',
  };
}

export default async function SlotSpinPage({
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
  const [base, recentPulls] = await Promise.all([
    getPackBySlug(slug),
    getRecentPulls(),
  ]);
  if (!base) notFound();

  return (
    <SlotMachineClient
      pack={base.pack}
      recentPulls={recentPulls}
      count={count}
    />
  );
}

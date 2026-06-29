import type { Metadata } from 'next';
import { getPackCategories } from '@/lib/data/packs';
import ClawClient from '@/app/claw/ClawClient';

export const metadata: Metadata = {
  title: 'Slot Machine',
  description: 'Pick a pack, choose how many to open, and spin the reels.',
};

// Pack catalog read live from the backend — same seam as /claw. Render fresh.
export const dynamic = 'force-dynamic';

export default async function SlotsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const [{ category }, categories] = await Promise.all([
    searchParams,
    getPackCategories(),
  ]);

  // Honor /slots?category=<key> when it exists; else default to "All Packs".
  const initialCategory =
    category && categories.some((c) => c.id === category) ? category : 'all';

  // /slots reuses the /claw layout verbatim (ClawClient) — only the card CTA
  // routes to the slot reel (/slots/[slug]?count=N) via mode="slots".
  return (
    <ClawClient
      categories={categories}
      initialCategory={initialCategory}
      mode="slots"
    />
  );
}

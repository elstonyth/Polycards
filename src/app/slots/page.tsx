import type { Metadata } from 'next';
import { getPackCategories } from '@/lib/data/packs';
import { getFreePackEligibility } from '@/lib/data/free-pack';
import CatalogClient from './CatalogClient';

export const metadata: Metadata = {
  title: 'Slot Machine',
  description: 'Pick a pack, choose how many to open, and spin the reels.',
};

// Pack catalog read live from the backend. Render fresh.
export const dynamic = 'force-dynamic';

export default async function SlotsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const [{ category }, categories, freePack] = await Promise.all([
    searchParams,
    getPackCategories(),
    // Per-customer and never cached; degrades to "not eligible" on any failure,
    // so it can't take the catalog down with it.
    getFreePackEligibility(),
  ]);

  // Honor /slots?category=<key> when it exists; else default to "All Packs".
  const initialCategory =
    category && categories.some((c) => c.id === category) ? category : 'all';

  return (
    <CatalogClient
      categories={categories}
      initialCategory={initialCategory}
      // The free pack is absent from `categories` by design (the backend hides
      // its category) — the badge is its only entry point.
      freePackSlug={freePack.eligible ? freePack.slug : null}
    />
  );
}

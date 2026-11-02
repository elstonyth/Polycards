import type { Metadata } from 'next';
import { getPackCategoriesForViewer } from '@/lib/data/packs';
import { getFreePackState } from '@/lib/data/free-pack';
import CatalogClient from './CatalogClient';

export const metadata: Metadata = {
  title: 'Slot Machine',
  description: 'Pick a pack, choose how many to open, and spin the reels.',
};

// Pack catalog read live from the backend. Render fresh.
export const dynamic = 'force-dynamic';

export default async function SlotsPage() {
  const [categories, freePack] = await Promise.all([
    // The live catalog, plus Drafts for a member of a staff group.
    getPackCategoriesForViewer(),
    // Per-visitor and never cached; degrades to "hidden" on any failure, so it
    // can't take the catalog down with it.
    getFreePackState(),
  ]);

  return (
    <CatalogClient
      // Every franchise gets a tab, "Coming soon" until it has packs; the client
      // picks one with packs from ?category= (else the first).
      categories={categories}
      // The free pack is absent from `categories` by design (the backend hides
      // its category) — the badge is its only entry point.
      freePack={freePack.mode === 'hidden' ? null : freePack}
    />
  );
}

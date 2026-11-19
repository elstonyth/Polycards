// TEMPORARY (WP-F flow groundwork): remove at integration, when the flow
// renders inside the homepage stage and the gated /slots/<id> page.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPackBySlug, getPackHighlights } from '@/lib/data/packs';
import { loadPackPage } from '@/lib/data/pack-page';
import {
  flowSeed,
  flowSeedFromHighlights,
} from '@/components/pack-flow/flow-seed';
import FlowPreviewClient from './FlowPreviewClient';

export const metadata: Metadata = {
  title: 'Flow preview',
  robots: { index: false, follow: false },
};

/**
 * The flow's chapters for one pack, with a flat stand-in where the 3D pack
 * will be. 404 unless `next dev` or the server runs with HOME_PREVIEW=1, as
 * /home-preview. Reading searchParams keeps the route dynamic, so the gate is
 * checked per request.
 *
 * - `/flow-preview/<slug>`: a cold-loaded pack page (the pack page's seed;
 *   "All packs" leaves for `/`).
 * - `?from=stage`: starts on a stand-in carousel of the pack's category; a tap
 *   focuses a pack the way the homepage will (`pushState` to `/slots/<id>`,
 *   the homepage seed, tiers fetched at focus), so Back and Forward walk it.
 */
export default async function FlowPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.HOME_PREVIEW !== '1'
  ) {
    notFound();
  }
  const { slug } = await params;
  const { from } = await searchParams;
  const base = await getPackBySlug(slug);
  if (!base || base.pack.draft || base.siblings.length === 0) notFound();

  if (from === 'stage') {
    const packs = base.siblings
      .filter((p) => !p.draft)
      .map((p) => ({
        ...p,
        categoryId: base.pack.categoryId,
        categoryName: base.pack.categoryName,
        icon: base.pack.icon,
      }));
    const highlights = await Promise.all(
      packs.map((p) => getPackHighlights(p.id)),
    );
    return (
      <FlowPreviewClient
        mode="stage"
        basePath={`/flow-preview/${encodeURIComponent(slug)}`}
        seeds={packs.map((p, i) =>
          flowSeedFromHighlights(p, highlights[i] ?? null),
        )}
      />
    );
  }

  const data = await loadPackPage(slug);
  if (!data) notFound();
  return (
    <FlowPreviewClient mode="pack" basePath="/" seeds={[flowSeed(data)]} />
  );
}

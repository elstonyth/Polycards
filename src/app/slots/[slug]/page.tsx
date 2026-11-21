// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { loadPackPage } from '@/lib/data/pack-page';
import { ProductJsonLd } from '@/lib/product-share';
import { packFlowAddress, packFlowOn } from '@/lib/preview-switch';
import { packMetadata } from '@/lib/pack-metadata';
import PackPage from './PackPage';

// The /slots pack detail — configurator/Top-Hits/odds; the "Open Pack" CTA
// launches the slot-machine reel (./spin). Backend-driven (catalog + gacha
// depth + live recent pulls), so render per request — each read degrades on
// its own (base → notFound; detail → empty gacha depth; pulls → empty).
export const dynamic = 'force-dynamic';

type Query = Record<string, string | string[] | undefined>;

/** The query as URL parameters (a repeated key keeps every value). */
const paramsOf = (query: Query) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    for (const one of typeof v === 'string' ? [v] : (v ?? [])) q.append(k, one);
  return q;
};

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Preview switch only: the pack's own address is never shown (see below),
  // so its pack is not read for a title.
  if (packFlowOn()) {
    const query = await searchParams;
    if (packFlowAddress(slug, paramsOf(query)) !== null) return {};
  }
  return packMetadata(slug);
}

export default async function SlotsPackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Query>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const countRaw = typeof query.count === 'string' ? query.count : undefined;
  // Preview switch only: the pack's own address (no `count`: the pack page's
  // links always carry one) opens the home flow on that pack, which puts this
  // address back once it has loaded. A document load is sent there by the
  // proxy before anything renders; a move inside the site takes this redirect.
  if (packFlowOn()) {
    const to = packFlowAddress(slug, paramsOf(query));
    if (to) redirect(to);
  }
  const parsed = Number(countRaw);
  const count = Number.isInteger(parsed) ? Math.min(3, Math.max(1, parsed)) : 1;
  // One loader for this render and for the picker's in-place switch
  // (/api/pack-page/[slug]), so the two always agree.
  const data = await loadPackPage(slug);
  if (!data) notFound();

  return (
    <>
      {!data.pack.draft && (
        <ProductJsonLd
          name={data.pack.name}
          description={`${data.pack.name} · ${data.pack.categoryName}`}
          sku={slug}
          path={`/slots/${slug}`}
        />
      )}
      <PackPage initial={data} initialQty={count} />
    </>
  );
}

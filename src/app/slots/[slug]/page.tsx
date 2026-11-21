// src/app/slots/[slug]/page.tsx
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPackBaseForViewer } from '@/lib/data/packs';
import { loadPackPage } from '@/lib/data/pack-page';
import { ProductJsonLd, shareImageMeta } from '@/lib/product-share';
import { homePreviewOn } from '@/components/pack-flow/flow-start';
import PackPage from './PackPage';

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
  const base = await getPackBaseForViewer(slug);
  if (!base) return { title: 'Pack' };
  const { name, categoryName } = base.pack;
  const path = `/slots/${slug}`;
  return {
    title: `${name} — ${categoryName}`,
    description: `Open the ${name} from ${categoryName}: see the top hits and odds before you rip it.`,
    // Replaces the layout's openGraph whole, so every field is restated.
    openGraph: {
      type: 'website',
      siteName: 'Polycards',
      title: name,
      description: `${name} · ${categoryName}`,
      url: path,
      images: [shareImageMeta(path, name)],
    },
  };
}

export default async function SlotsPackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const countRaw = typeof query.count === 'string' ? query.count : undefined;
  // Preview switch only: the pack's own address (no `count`: the pack page's
  // links always carry one) opens the home flow on that pack, which puts this
  // address back once it has loaded. A document load replaces this document
  // with the flow page at once (so its loader shows from its first paint); a
  // move inside the site takes the router's own redirect.
  if (homePreviewOn() && query.count === undefined) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (typeof v === 'string' && k !== 'focus') q.set(k, v);
    q.set('focus', slug);
    const to = `/home-preview?${q.toString()}`;
    if ((await headers()).get('rsc') === null)
      return (
        <script
          dangerouslySetInnerHTML={{
            __html: `location.replace(${JSON.stringify(to)})`,
          }}
        />
      );
    redirect(to);
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

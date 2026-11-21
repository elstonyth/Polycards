import type { Metadata } from 'next';
import { getPackBaseForViewer } from '@/lib/data/packs';
import { shareImageMeta } from '@/lib/product-share';

/** The title of a pack page whose pack cannot be read. */
export const UNKNOWN_PACK_TITLE = 'Pack';

/**
 * The pack page's title, description and share card for pack `slug`. The
 * home preview's flow reuses it for a load onto the pack's own address.
 */
export async function packMetadata(slug: string): Promise<Metadata> {
  // Backend catalog (source of truth) — a backend-created pack gets a real
  // title too, not just the baked 8. Next dedupes the fetch with the page body.
  const base = await getPackBaseForViewer(slug);
  if (!base) return { title: UNKNOWN_PACK_TITLE };
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

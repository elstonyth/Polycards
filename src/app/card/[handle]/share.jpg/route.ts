import sharp from 'sharp';
import { getCardResult } from '@/lib/data/cards';
import { logger } from '@/lib/logger';
import { SITE_URL } from '@/lib/site';
import { createTtlCache } from '@/lib/ttl-cache';

/**
 * GET /card/<handle>/share.jpg — the picture Meta and link previews show for a
 * card (the card page's og:image and Product image).
 *
 * Square and opaque on purpose. Meta crops product tiles to 1:1 and flattens
 * transparency to black, and left to guess it picked the largest <img> on the
 * page: the see-through tier frame. That ran in Facebook ads as a black tile
 * with orange edges (2026-10-31). A bare slab link would still lose its label
 * and foot to the crop.
 */
const SIDE = 1080;
const MARGIN = 60;
// neutral-900: the page background, and public/seo/og.png's.
const BACKGROUND = '#171717';

// A public URL that costs a CDN fetch plus sharp: one compose per art per hour
// per pod, whatever query string a bot adds. Keyed by art URL so a re-baked
// slab shows at once. Own store, so it cannot evict the catalog's keys.
const SHARE_TTL_MS = 60 * 60 * 1000;
const shareMemo = createTtlCache(64);

async function composeShareImage(
  artUrl: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const art = await fetch(new URL(artUrl, SITE_URL), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!art.ok) throw new Error(`card art answered ${art.status}`);
  const jpeg = await sharp(Buffer.from(await art.arrayBuffer()))
    .flatten({ background: BACKGROUND })
    .resize(SIDE - 2 * MARGIN, SIDE - 2 * MARGIN, {
      fit: 'contain',
      background: BACKGROUND,
    })
    .extend({
      top: MARGIN,
      bottom: MARGIN,
      left: MARGIN,
      right: MARGIN,
      background: BACKGROUND,
    })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(jpeg);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await params;
  const result = await getCardResult(handle);
  if (result.status === 'ok') {
    const art = result.card.slabImage ?? result.card.image;
    try {
      const jpeg = await shareMemo(art, SHARE_TTL_MS, () =>
        composeShareImage(art),
      );
      return new Response(jpeg, {
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        },
      });
    } catch (err) {
      logger.warn(`[card share image] ${handle}`, err);
    }
  }
  // A preview with the logo beats a broken one. Relative Location: see the
  // note in src/app/r/[code]/route.ts on request.url behind the DO proxy.
  return new Response(null, {
    status: 302,
    headers: { location: '/seo/og.png', 'cache-control': 'no-store' },
  });
}

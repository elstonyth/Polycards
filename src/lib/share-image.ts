import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { logger } from '@/lib/logger';
import { SHARE_IMAGE_SIDE } from '@/lib/product-share';
import { createTtlCache } from '@/lib/ttl-cache';

/**
 * The picture Meta and link previews show for a card or pack (the page's
 * og:image and Product image), served by each route's share.jpg.
 *
 * Square and opaque on purpose. Meta crops product tiles to 1:1 and flattens
 * transparency to black, and left to guess it picked the largest <img> on the
 * page: the see-through tier frame. That ran in Facebook ads as a black tile
 * with orange edges (2026-10-31). A bare link to the art would still lose a
 * slab's label and a pack's top and foot to the crop.
 */
const MARGIN = 60;
// neutral-900: the page background, and public/seo/og.png's.
const BACKGROUND = '#171717';

// A public URL that costs a fetch plus sharp: one compose per art per hour per
// pod, whatever query string a bot adds. Keyed by art URL so re-baked art shows
// at once. Own store, so it cannot evict the catalog's keys.
const SHARE_TTL_MS = 60 * 60 * 1000;
const shareMemo = createTtlCache(64);

async function loadArt(art: string): Promise<Buffer> {
  // Our own public/ asset, read from disk: a fetch would leave the pod and come
  // back through Cloudflare, whose hosting-network challenge can refuse it.
  // new URL collapses any ../, so the path stays inside public/.
  if (art.startsWith('/')) {
    const { pathname } = new URL(art, 'http://local');
    return readFile(join(process.cwd(), 'public', pathname));
  }
  const res = await fetch(art, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`art answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function composeShareImage(
  art: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const inner = SHARE_IMAGE_SIDE - 2 * MARGIN;
  const jpeg = await sharp(await loadArt(art))
    .flatten({ background: BACKGROUND })
    .resize(inner, inner, { fit: 'contain', background: BACKGROUND })
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

export async function shareImageResponse(
  art: string | null | undefined,
): Promise<Response> {
  if (art) {
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
      logger.warn(`[share image] ${art}`, err);
    }
  }
  // A preview with the logo beats a broken one. Relative Location: see the
  // note in src/app/r/[code]/route.ts on request.url behind the DO proxy.
  return new Response(null, {
    status: 302,
    headers: { location: '/seo/og.png', 'cache-control': 'no-store' },
  });
}

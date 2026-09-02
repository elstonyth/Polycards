import type { NextRequest } from 'next/server';
import { getPullGaps, resolveFeedPackSlug } from '@/lib/data/packs';
import { cached } from '@/lib/ttl-cache';
import { isRarity } from '@/lib/packs-format';
import { RARITY_ORDER } from '@/lib/rarity';

// Same-origin proxy for GET /store/pulls/gaps — the pull-history STATS chart.
// Fetched by the client only while the chart tab is open (and again when the
// tier's drought counter moves), never on a timer, so it is far quieter than
// the feed; it still gets the feed's 5s memo so a burst of tab-switching costs
// one backend hop per (pack, tier) window. Same key gating as /api/recent-pulls
// (resolveFeedPackSlug): a garbage pack collapses to the global feed and a
// garbage tier to the apex tier instead of minting a cache key.
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 5_000;

export async function GET(request: NextRequest) {
  const pack = await resolveFeedPackSlug(
    request.nextUrl.searchParams.get('pack_id'),
  );
  const rarityRaw = request.nextUrl.searchParams.get('rarity') ?? '';
  const rarity = isRarity(rarityRaw) ? rarityRaw : RARITY_ORDER[0]!;
  try {
    // The loader THROWS on a null read (ttl-cache contract): getPullGaps
    // swallows backend failures into null, and memoising that null would
    // show every viewer "unavailable" for the whole window after one blip.
    const body = await cached(
      `pull-gaps:${pack}:${rarity}`,
      CACHE_TTL_MS,
      async () => {
        const gaps = await getPullGaps(rarity, pack || undefined);
        if (!gaps) throw new Error('pull gaps unavailable');
        return JSON.stringify(gaps);
      },
    );
    return new Response(body, {
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    // Not cached — the next request retries. The chart shows its
    // unavailable state on a non-2xx.
    return new Response('null', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

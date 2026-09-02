import type { NextRequest } from 'next/server';
import {
  getPackBySlug,
  getPackCategories,
  getPullGaps,
} from '@/lib/data/packs';
import { cached } from '@/lib/ttl-cache';
import { isRarity } from '@/lib/packs-format';
import { RARITY_ORDER } from '@/lib/rarity';

// Same-origin proxy for GET /store/pulls/gaps — the pull-history STATS chart.
// Fetched by the client only while the chart tab is open (and again when the
// tier's drought counter moves), never on a timer, so it is far quieter than
// the feed; it still gets the feed's 5s memo so a burst of tab-switching costs
// one backend hop per (pack, tier) window. Same key gating as /api/recent-pulls:
// pack_id must be a real catalog slug (or the unlisted-but-reachable free
// pack), rarity a known tier — a garbage value collapses to the global feed /
// apex tier instead of minting a cache key.
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 5_000;

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('pack_id')?.trim() ?? '';
  const cats = await getPackCategories();
  const known = new Set(cats.flatMap((c) => c.packs.map((p) => p.id)));
  const slugShaped = /^[a-z0-9-]{1,64}$/.test(raw);
  const pack =
    slugShaped && (known.has(raw) || (await getPackBySlug(raw)) !== null)
      ? raw
      : '';
  const rarityRaw = request.nextUrl.searchParams.get('rarity') ?? '';
  const rarity = isRarity(rarityRaw) ? rarityRaw : RARITY_ORDER[0]!;
  const body = await cached(
    `pull-gaps:${pack}:${rarity}`,
    CACHE_TTL_MS,
    async () => JSON.stringify(await getPullGaps(rarity, pack || undefined)),
  );
  return new Response(body, {
    headers: { 'content-type': 'application/json' },
  });
}

import { NextResponse } from 'next/server';
import { rm } from '@/lib/format';
import type { PackCard } from '@/lib/packs-data';
import { getPackDetail } from '@/lib/data/packs';
import { cachedJson } from '@/lib/ttl-cache';

// Same-origin endpoint the pack page polls (60s) to refresh EVERY grid price
// in one request. Same CORS rationale as /api/recent-pulls.
export const dynamic = 'force-dynamic';

// getPackDetail memoises the backend row for 15s, but each request still
// re-mapped and re-serialized the whole pool (up to ~450 cards, ~200 KB) — per
// open tab per poll, plus every public scraper hit. Hold the serialized body for
// the same 15s so a request is a string copy. Worst case a price reaches the
// poll ~30s after the row memo refreshed; the poll itself is 60s.
const CACHE_TTL_MS = 15_000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const miss = `pack detail miss: ${slug}`;
  try {
    return await cachedJson(
      `pack-detail-json:${slug}`,
      CACHE_TTL_MS,
      async () => {
        const detail = await getPackDetail(slug);
        // Thrown, not returned: cached() evicts a rejection, so a 404 or outage
        // is never held for the window and garbage slugs keep no entry.
        if (!detail) throw new Error(miss);
        // Older open tabs select by id and render the two-decimal value string.
        const withLegacyFields = (card: PackCard) => ({
          ...card,
          id: card.handle,
          value: card.priceMyr === null ? '—' : rm(card.priceMyr),
        });
        return {
          detail: {
            ...detail,
            pool: detail.pool.map(withLegacyFields),
            topHits: detail.topHits.map(withLegacyFields),
          },
        };
      },
    );
  } catch (err) {
    // Only the miss is a 404; anything else is a real bug and stays a 500.
    if (!(err instanceof Error && err.message === miss)) throw err;
    return NextResponse.json({ message: 'not found' }, { status: 404 });
  }
}

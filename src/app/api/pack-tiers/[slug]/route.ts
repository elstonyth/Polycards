import { NextResponse } from 'next/server';
import { getPackTiers } from '@/lib/data/packs';
import { cachedJson } from '@/lib/ttl-cache';
import { homePreviewOn } from '@/lib/preview-switch';

// The homepage flow's per-pack data: what a logged-out visitor's pack page
// shows, by tier (lib/pack-tiers), plus the pack's live price, buyback and
// stock. Public, same-origin fetches only (src/proxy.ts POLLED_JSON).
export const dynamic = 'force-dynamic';

// The projection itself is cached for 60s (getPackTiers); the serialized body
// is held 15s, as /api/pack-detail does, so a poll is a string copy.
const CACHE_TTL_MS = 15_000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  // only the home preview reads it: not there with the switch off
  if (!homePreviewOn())
    return NextResponse.json({ message: 'not found' }, { status: 404 });
  const miss = `pack tiers route miss: ${slug}`;
  try {
    return await cachedJson(
      `pack-tiers-json:${slug}`,
      CACHE_TTL_MS,
      async () => {
        const tiers = await getPackTiers(slug);
        // Thrown, not returned: cached() evicts a rejection, so a 404 or outage
        // is never held for the window and made-up slugs keep no entry.
        if (!tiers) throw new Error(miss);
        return tiers;
      },
    );
  } catch (err) {
    // Only the miss is a 404; anything else is a real bug and stays a 500.
    if (!(err instanceof Error && err.message === miss)) throw err;
    return NextResponse.json({ message: 'not found' }, { status: 404 });
  }
}

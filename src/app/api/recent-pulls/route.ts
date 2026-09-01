import type { NextRequest } from 'next/server';
import {
  getPackBySlug,
  getPackCategories,
  getRecentPulls,
} from '@/lib/data/packs';
import { cached } from '@/lib/ttl-cache';

// Same-origin endpoint the "Recent Pulls" feeds poll for live updates — a
// direct Store-API call from the browser (:4000 -> :9000) would be CORS-blocked,
// so the fetch runs server-side here. The payload carries the won card, source
// pack label, time, and the puller's display name (first_name in full — never
// id/email; resolved backend-side).
export const dynamic = 'force-dynamic';

// Mirrors the backend route's own 5s window (store/pulls/recent). That one caps
// the DB work; this one caps what the STOREFRONT pays — the backend hop plus the
// zod parse and row mapping in getRecentPulls — which is otherwise charged once
// per poll tick per open tab. The serialized body, not the array, is what gets
// held: at poll volume, re-stringifying ~6.6 KB per request is the remaining
// per-request cost once the fetch is gone.
//
// A new pull surfaces up to 5s later than before, on top of the backend's own
// 5s window. Invisible on a feed whose rows are labelled in whole minutes.
//
// Unlike getPackCategories and getAvatarFrames, the degradation is NOT hoisted
// out of the cached loader here: getRecentPulls catches its own failure and
// returns [], and its OTHER callers (the home and pack-detail server renders)
// depend on that — making it throw would 500 the force-dynamic pack page. So a
// blip can cache `{"pulls":[]}` for one 5s window. That is inert: the client
// hook ignores an empty payload for the pack it is already showing
// (use-recent-pulls), so a healthy feed never blanks from it.
const CACHE_TTL_MS = 5_000;

export async function GET(request: NextRequest) {
  // ?pack_id=<Pack.slug> scopes the feed to one pack (the /slots/[slug] pages);
  // absent = the global feed (home). Same param name as the Store route it
  // proxies, so the chain reads end-to-end without a rename. The cache key
  // carries it — a single key would serve one pack's rows to every other pack.
  //
  // Cache keys must be bounded to the real catalog, not just kebab-shaped: an
  // unbounded valid-shaped namespace still fills the TTL Map and evicts the
  // hot keys. getPackCategories is already cached (same 30s window), so this
  // adds no backend hop. A slug not in the catalog scopes to the global feed —
  // the same rows getRecentPulls returns for an unknown pack anyway, now
  // without minting a per-garbage-key cache entry.
  //
  // One pack is reachable but never LISTED: the free welcome pack (GET
  // /store/packs filters free_welcome out — see getUncatalogedPack). A catalog
  // miss therefore falls through to the detail route before the slug is
  // discarded, or that pack's spin page flips to the global feed on its first
  // poll. Garbage slugs still mint no key: the detail route 404s them.
  const raw = request.nextUrl.searchParams.get('pack_id')?.trim() ?? '';
  const cats = await getPackCategories();
  const known = new Set(cats.flatMap((c) => c.packs.map((p) => p.id)));
  // Shape-gate before the detail hop: this endpoint is public, so a garbage
  // pack_id must not cost a backend round-trip (and an error log) per request.
  const slugShaped = /^[a-z0-9-]{1,64}$/.test(raw);
  const pack =
    slugShaped && (known.has(raw) || (await getPackBySlug(raw)) !== null)
      ? raw
      : '';
  const body = await cached(`recent-pulls:${pack}`, CACHE_TTL_MS, async () =>
    JSON.stringify({ pulls: await getRecentPulls(pack || undefined) }),
  );
  return new Response(body, {
    headers: { 'content-type': 'application/json' },
  });
}

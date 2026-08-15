import { NextResponse, type NextRequest } from 'next/server';
import { getRecentPulls } from '@/lib/data/packs';

// Same-origin endpoint the "Recent Pulls" feeds poll for live updates — a
// direct Store-API call from the browser (:4000 -> :9000) would be CORS-blocked,
// so the fetch runs server-side here. The payload carries the won card, source
// pack label, time, and the puller's display name (first_name in full — never
// id/email; resolved backend-side). Never cached so each poll reflects the ledger.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // ?pack_id=<Pack.slug> scopes the feed to one pack (the /slots/[slug] pages);
  // absent = the global feed (home). Same param name as the Store route it
  // proxies, so the chain reads end-to-end without a rename.
  const pack = request.nextUrl.searchParams.get('pack_id')?.trim();
  const pulls = await getRecentPulls(pack || undefined);
  return NextResponse.json({ pulls });
}

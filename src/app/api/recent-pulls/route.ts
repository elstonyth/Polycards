import { NextResponse } from 'next/server';
import { getRecentPulls } from '@/lib/data/packs';

// Same-origin endpoint the "Recent Pulls" feeds poll for live updates — a
// direct Store-API call from the browser (:4000 -> :9000) would be CORS-blocked,
// so the fetch runs server-side here. The payload carries the won card, source
// pack label, time, and the puller's display name (first_name in full — never
// id/email; resolved backend-side). Never cached so each poll reflects the ledger.
export const dynamic = 'force-dynamic';

export async function GET() {
  const pulls = await getRecentPulls();
  return NextResponse.json({ pulls });
}

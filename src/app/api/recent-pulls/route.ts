import { NextResponse } from 'next/server';
import { getRecentPulls } from '@/lib/data/packs';

// Same-origin endpoint the home "Recent Pulls" feed polls for live updates — a
// direct Store-API call from the browser (:4000 -> :9000) would be CORS-blocked,
// so the fetch runs server-side here. The payload is already PII-free (won card +
// source pack + time only). Never cached so each poll reflects the live ledger.
export const dynamic = 'force-dynamic';

export async function GET() {
  const pulls = await getRecentPulls();
  return NextResponse.json({ pulls });
}

import { NextResponse } from 'next/server';
import { getLeaderboard } from '@/lib/data/leaderboard';

// Same-origin endpoint the homepage "Weekly Leaderboard" teaser fetches on mount
// to swap its static mock board for the live one — a direct Store-API call from
// the browser (:4000 -> :9000) would be CORS-blocked, so the fetch runs
// server-side here. Keeps the homepage itself statically rendered. The payload
// is PII-safe (display name + avatar seed only).
export const dynamic = 'force-dynamic';

export async function GET() {
  const entries = await getLeaderboard('weekly');
  return NextResponse.json({ entries });
}

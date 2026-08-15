import { NextResponse } from 'next/server';
import { getFreePackState } from '@/lib/data/free-pack';

// Same-origin endpoint the site-wide floating badge (GlobalFreePackBadge)
// re-reads on every route/auth change — the customer JWT is an httpOnly cookie
// the browser can't read, and a direct Store-API call would be CORS-blocked,
// so the state read runs server-side here. Never cached: the badge must vanish
// on the next navigation after the one-time claim is spent.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getFreePackState());
}

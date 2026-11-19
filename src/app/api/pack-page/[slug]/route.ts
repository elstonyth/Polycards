import { NextResponse } from 'next/server';
import { loadPackPage } from '@/lib/data/pack-page';

// What the pack page's picker fetches to switch packs in place: the same data
// the page render gets (loadPackPage), so a switch and a fresh load of the same
// address show the same thing. Same-origin only (see proxy.ts).
//
// Viewer-specific (a member's Drafts, the free pack's eligibility), so it is
// never cached: not here, not by a browser, not by an edge.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const data = await loadPackPage(slug);
  if (!data) {
    return NextResponse.json(
      { message: 'not found' },
      { status: 404, headers: NO_STORE },
    );
  }
  return NextResponse.json(data, { headers: NO_STORE });
}

import { NextResponse } from 'next/server';
import { rm } from '@/lib/format';
import type { PackCard } from '@/lib/packs-data';
import { getPackDetail } from '@/lib/data/packs';

// Same-origin endpoint the pack page polls (60s) to refresh EVERY grid price
// in one request. Same CORS rationale as /api/recent-pulls.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const detail = await getPackDetail(slug);
  if (!detail) {
    return NextResponse.json({ message: 'not found' }, { status: 404 });
  }
  // Older open tabs select by id and render the two-decimal value string.
  const withLegacyFields = (card: PackCard) => ({
    ...card,
    id: card.handle,
    value: card.priceMyr === null ? '—' : rm(card.priceMyr),
  });
  return NextResponse.json({
    detail: {
      ...detail,
      pool: detail.pool.map(withLegacyFields),
      topHits: detail.topHits.map(withLegacyFields),
    },
  });
}

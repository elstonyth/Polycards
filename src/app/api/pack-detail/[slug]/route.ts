import { NextResponse } from 'next/server';
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
  return NextResponse.json({ detail });
}

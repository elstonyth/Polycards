import { getPackBySlug } from '@/lib/data/packs';
import { shareImageResponse } from '@/lib/share-image';

/** GET /slots/<slug>/share.jpg — see src/lib/share-image.ts. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const base = await getPackBySlug(slug);
  return shareImageResponse(base?.pack.image);
}

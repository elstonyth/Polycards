import { getCardResult } from '@/lib/data/cards';
import { shareImageResponse } from '@/lib/share-image';

/** GET /card/<handle>/share.jpg — see src/lib/share-image.ts. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await params;
  const result = await getCardResult(handle);
  return shareImageResponse(
    result.status === 'ok'
      ? (result.card.slabImage ?? result.card.image)
      : null,
  );
}

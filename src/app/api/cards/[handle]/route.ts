import { NextResponse } from 'next/server';
import { getCard } from '@/lib/data/cards';

// Same-origin endpoint the card-detail view polls for its 60s price refresh —
// a direct browser call to :9000 would be CORS-blocked (same pattern as
// /api/recent-pulls). Never cached so each poll reflects the live FX/markup.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;
  const card = await getCard(handle);
  if (!card) {
    return NextResponse.json({ message: 'not found' }, { status: 404 });
  }
  // Older open tabs still read these fields at this unchanged URL.
  return NextResponse.json({
    card: {
      ...card,
      marketPriceMyr: card.priceMyr,
      slab_image: card.slabImage,
      pokemon_dex: card.pokemonDex,
      sprite_image: card.spriteImage,
    },
  });
}

'use client';

import { useCardPrice } from '@/lib/use-card-price';
import { CardDetail } from '@/components/cards/CardDetail';
import type { CardSeed } from '@/components/cards/CardDetailOverlay';
import type { CardDetailData } from '@/lib/data/cards';
import { rm } from '@/lib/format';

/** Full-page variant: server data is the seed AND the initial detail; the 60s
 *  visibility-gated refresh keeps a long-lived tab current. */
export function CardDetailHydrated({
  initial,
  frameVariant,
}: {
  initial: CardDetailData;
  /** Set when the visitor arrived from a surface that frames the card itself
   *  (the weekly challenge's prism prizes) — see CardDetail. */
  frameVariant?: 'prism';
}) {
  const detail = useCardPrice(initial.handle, initial) ?? initial;
  const seed: CardSeed = {
    handle: initial.handle,
    name: initial.name,
    image: initial.image,
    slabImage: initial.slab_image,
    value: rm(initial.marketPriceMyr),
    rarity: initial.rarity,
    frameVariant,
  };
  // entrance: the page renders cold (often a shared link opened by a stranger),
  // so it owns the choreography. The overlay animates its own panel instead.
  return <CardDetail seed={seed} detail={detail} entrance />;
}

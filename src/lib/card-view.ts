/**
 * The ONE card view, and the one mapper onto it.
 *
 * A Card (CONTEXT.md) is the graded collectible: name, art, slab, live MYR
 * price, the pixel-Pokémon that stands for it on the reel. Every card the
 * storefront renders — pool tile, reveal slab, vault row, profile showcase,
 * pull-history row, delivery item, challenge prize, card detail — is a
 * `CardView` or a `CardView & {…}` / `Pick<CardView, …>`. Nine seams used to
 * hand-map the wire shape and had drifted on the price default (`?? 0` in the
 * vault and the reel, `?? null` everywhere else).
 *
 * Money rule: `priceMyr` is a NUMBER or null, never a formatted string, and
 * null means "the backend did not price this card" — never 0 (a real price).
 * Components render it with `rm()` / `rm0()` and decide the '—' themselves.
 *
 * What is NOT here: anything that belongs to the Pull (locked, showcased,
 * won-in-challenge, the pull id, the buyback quote) or to the pack's odds row
 * (weight, top-hit order). `rarity` rides along because every card view
 * frames its slab by tier, but it is the (pack, card) odds row's tier, not the
 * card's — null when the row is gone or the backend omitted it.
 */
import {
  CardWireSchema,
  type CardWireInput,
  type CardWire,
} from '@/lib/data/schemas';
import type { Rarity } from '@/lib/packs-data';

export { CardWireSchema, type CardWire, type CardWireInput };

export type CardView = {
  /** Public route key — /card/<handle>. '' when the route sent none. */
  handle: string;
  name: string;
  /** Raw card art. '' when absent — SlabImage still needs a string src. */
  image: string;
  /** The graded-slab composite; null = raw card (no case, no tier band). */
  slabImage: string | null;
  /** Tier of the (pack, card) odds row; null renders frameless, never a
   *  guessed tier. */
  rarity: Rarity | null;
  /** Live MYR display price (FMV × FX × margin). null = unpriced (an
   *  un-enriched backend) — render '—', not RM 0.00. */
  priceMyr: number | null;
  /** Configured pixel-Pokémon (mirror of the linked library entry); null
   *  falls back to name-derivation. */
  pokemonDex: number | null;
  spriteImage: string | null;
};

/** The wire card → the view. Lenient by construction (see CardWireSchema):
 *  every field degrades to its default, so this never fails on an object. */
export function toCardView(raw: CardWireInput): CardView {
  const c = CardWireSchema.parse(raw);
  return {
    handle: c.handle,
    name: c.name,
    image: c.image,
    slabImage: c.slab_image,
    rarity: c.rarity,
    priceMyr: c.marketPriceMyr,
    pokemonDex: c.pokemon_dex,
    spriteImage: c.sprite_image,
  };
}

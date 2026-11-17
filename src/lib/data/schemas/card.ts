import { z } from './zod';
import { finite, rarity } from './shared';

/**
 * The card object as EVERY card-bearing route sends it — the odds row, the
 * recent pull, the open/batch/free-rip `card`, the vault row's `card`, the
 * profile collection, the delivery item, the challenge prize, the card detail.
 * `toCardView` (src/lib/card-view.ts) parses through this and is the one place
 * the wire card becomes a `CardView`.
 *
 * Every field `.catch()`es to its view default on purpose: this schema decides
 * what a field READS AS, never whether the row survives. Which fields must be
 * present for a row to render at all stays each route's own call
 * (`WonCardSchema`, `OddsEntrySchema`, `VaultItemSchema.card`, …) — they are no
 * stricter or looser than before, and a card that passed them cannot fail here.
 * `z.object`, not `looseObject`: the mapper reads only these keys, and the
 * index signature a loose object carries would keep hand-typed rows
 * (`BackendVaultItem`, `PublicProfileCard`) from typing as input.
 *
 * The money invariant lives here: `marketPriceMyr` (live MYR display price,
 * FMV × FX × margin) is null when the backend did not price the card — never 0,
 * which is a real price. Raw USD `market_value` is deliberately not read.
 */
export const CardWireSchema = z.object({
  handle: z.string().catch(''),
  name: z.string().catch(''),
  set: z.string().catch(''),
  image: z.string().catch(''),
  slab_image: z.string().nullable().catch(null),
  rarity: rarity.nullable().catch(null),
  marketPriceMyr: finite.nullable().catch(null),
  pokemon_dex: z.number().int().positive().nullable().catch(null),
  sprite_image: z.string().nullable().catch(null),
});
export type CardWire = z.infer<typeof CardWireSchema>;
/** What `toCardView` accepts: any object — each key is optional and untyped
 *  because the schema above defaults every one. (`z.input` would not do: in
 *  zod 4 a `.catch()` field's input type is its output type, i.e. required.) */
export type CardWireInput = Partial<Record<keyof CardWire, unknown>>;

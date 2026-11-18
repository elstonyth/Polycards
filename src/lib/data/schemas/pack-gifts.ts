import { z } from './zod';
import { finite, listOf } from './shared';

/** GET /store/pack-gifts — the packs gifted into the customer's vault. A bad
 *  row drops on its own; a malformed body reads as no gifts (the open then
 *  charges the price the screen showed — never a silent gift). */
export const PackGiftsSchema = z.looseObject({
  gifts: listOf(
    z.looseObject({
      pack_id: z.string(),
      count: finite,
      title: z.string(),
      image: z.string().nullable().catch(null),
      price: finite,
      available: z.boolean(),
    }),
  ),
});

/**
 * Malaysia's 16 states and federal territories, as the canonical values the
 * address forms write into `province`.
 *
 * These feed `deliveryZone`'s province arm
 * (src/lib/delivery-fee.ts + backend/packages/api/src/modules/packs/delivery.ts).
 * The three East Malaysian spellings — `Sabah`, `Sarawak` and `W.P. Labuan` —
 * are LOAD-BEARING: each has to match `EAST_PLACE_RE`'s word-boundary
 * alternations (`sabah`, `sarawak`, `labuan`) case-insensitively. Renaming one
 * of those three silently re-zones real shipments from East (RM35) to West
 * (RM15) and changes what customers are charged. The remaining thirteen must
 * NOT match any alternation, or a West address is billed the East rate.
 *
 * Offered as a fixed list rather than free text on purpose: a customer typing
 * "Sabah, Malaysia" or "sabah " still has to zone East, and a select removes
 * the question.
 */
export const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Perak',
  'Perlis',
  'Pulau Pinang',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
  'W.P. Kuala Lumpur',
  'W.P. Labuan',
  'W.P. Putrajaya',
] as const;

export type MalaysianState = (typeof MY_STATES)[number];

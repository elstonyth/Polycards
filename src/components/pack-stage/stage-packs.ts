/**
 * Pack stage data: the server's catalogue projected into the stage's own
 * `StagePack` shape (plan sections 2 and 3). Pure and server-safe.
 *
 * This is the ONLY pack-stage file that imports the 3D catalogue, and only its
 * sync lookup (data, no three.js). No client file may import this module: the
 * client gets the picture URLs as props, inside each `StagePack`.
 */
import { pack3dAssets } from '@/components/pack-3d/catalog';
import { rm, rm0 } from '@/lib/format';
import {
  FLAT_BUYBACK_PERCENT,
  isTicketPack,
  packHref,
  shelvePacks,
  type Pack,
  type PackCard,
  type PackCategory,
} from '@/lib/packs-data';
import type { StageArt, StageCategory, StagePack } from './contract';

/**
 * Owner decision 2 (plan section 11, revised 2026-11-19): which order the
 * carousel walks a category in. 'price' = cheapest first, ties in catalogue
 * order; 'slots' = the /slots catalogue's order (`shelvePacks`: pack type
 * shelves, cheapest first on each); 'ladder' = the old home ladder's order
 * (rounded price, high to low). The starting pack is STAGE_START_INDEX
 * (StageTrack.tsx).
 */
export const STAGE_ORDER: 'price' | 'slots' | 'ladder' = 'price';

/** One category's packs in the stage's walking order. Never drops a pack. */
export function orderStagePacks(packs: Pack[]): Pack[] {
  // Array.prototype.sort is stable: equal prices keep catalogue order.
  if (STAGE_ORDER === 'price')
    return [...packs].sort((a, b) => a.priceMyr - b.priceMyr);
  if (STAGE_ORDER === 'ladder') {
    return [...packs].sort(
      (a, b) => Math.round(b.priceMyr) - Math.round(a.priceMyr),
    );
  }
  return shelvePacks(packs).flatMap((shelf) => shelf.packs);
}

/** Looks a pack id up in the 3D catalogue. Injectable for tests. */
export type Art3dLookup = (id: string) => StageArt | null;

const catalogueArt: Art3dLookup = (id) => {
  const assets = pack3dAssets(id);
  return assets
    ? {
        front: assets.front,
        frontHalf: assets.frontHalf,
        width: assets.width,
        height: assets.height,
      }
    : null;
};

/** One pack as the stage draws it. Capsules (ticket packs) never get 3D. */
export function toStagePack(
  pack: Pack,
  chase: PackCard | null,
  art3dOf: Art3dLookup = catalogueArt,
): StagePack {
  const ticket = isTicketPack(pack);
  return {
    id: pack.id,
    name: pack.name,
    priceMyr: pack.priceMyr,
    priceLabel: rm0(pack.priceMyr),
    href: packHref(pack.id, 1),
    soldOut: pack.inStock === false,
    image: pack.image,
    art3d: ticket ? null : art3dOf(pack.id),
    // getPackHighlights only hands over a priced card; a ticket has no chase.
    chaseLabel: !ticket && chase?.priceMyr != null ? rm(chase.priceMyr) : null,
    buybackPercent: pack.buybackPercent ?? FLAT_BUYBACK_PERCENT,
    boost: pack.boost === true,
    ticket,
  };
}

/**
 * Every category that has packs, in catalogue order, each in the stage's
 * walking order. Empty categories are left out: their tab is the disabled
 * "Coming soon" one and they have no panel.
 */
export function toStageCategories(
  categories: PackCategory[],
  chaseByPack: ReadonlyMap<string, PackCard | null>,
  art3dOf: Art3dLookup = catalogueArt,
): StageCategory[] {
  return categories
    .filter((c) => c.packs.length > 0)
    .map((c) => ({
      id: c.id,
      packs: orderStagePacks(c.packs).map((p) =>
        toStagePack(p, chaseByPack.get(p.id) ?? null, art3dOf),
      ),
    }));
}

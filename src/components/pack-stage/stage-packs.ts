/**
 * Pack stage data: the server's catalogue projected into the stage's own
 * `StagePack` shape. Pure and server-safe.
 *
 * This is the ONLY pack-stage file that imports the 3D catalogue and the 3D
 * capsule set, and only their sync lookups (data, no three.js). No client file may import this module: the
 * client gets the picture URLs as props, inside each `StagePack`.
 */
import { capsule3dAssets } from '@/components/pack-3d/capsule';
import { pack3dAssets } from '@/components/pack-3d/catalog';
import { rm, rm0 } from '@/lib/format';
import {
  CATALOG_GROUP_HEADING,
  FLAT_BUYBACK_PERCENT,
  PACK_LANGUAGE_LABEL,
  PACK_LANGUAGE_ORDER,
  PACK_TYPE_LABEL,
  catalogGroupOf,
  isTicketPack,
  packHref,
  shelfPacks,
  shelvePacks,
  type Pack,
  type PackCard,
  type PackCategory,
  type PackShelf,
} from '@/lib/packs-data';
import type {
  StageArt,
  StageCategory,
  StageLanguageCut,
  StagePack,
  StageShelf,
} from './contract';
import { ALL_SHELF } from './stage-filter';

/**
 * Owner decision 2: which order the
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

/** A capsule's 3D set: its own picture, at the size the model was fitted to. */
const capsuleArt = (pack: Pack): StageArt | null => {
  const assets = capsule3dAssets(pack.id);
  return assets
    ? {
        front: pack.image,
        frontHalf: pack.image,
        width: assets.picture.width,
        height: assets.picture.height,
        shape: 'capsule',
      }
    : null;
};

/**
 * One pack as the stage draws it. A capsule (ticket pack) gets 3D from the
 * capsule set (`capsule3dAssets`), never from the sleeve catalogue.
 */
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
    art3d: ticket ? capsuleArt(pack) : art3dOf(pack.id),
    // getPackHighlights only hands over a priced card; a ticket has no chase.
    chaseLabel: !ticket && chase?.priceMyr != null ? rm(chase.priceMyr) : null,
    buybackPercent: pack.buybackPercent ?? FLAT_BUYBACK_PERCENT,
    boost: pack.boost === true,
    ticket,
  };
}

/**
 * A shelf's composition caption: the shared `CATALOG_GROUP_HEADING` text, and
 * only when it is TRUE of every pack on the shelf. That is when every pack has
 * the same `catalogGroupOf` and it is 'graded' (PSA 10 gate) or 'raw'. A mixed
 * shelf, a 'more' shelf and any shelf holding a ticket pack (no cards to
 * describe, as `packFacts`) get none.
 */
export function shelfCaption(packs: readonly Pack[]): string | null {
  const first = packs[0];
  if (!first || packs.some(isTicketPack)) return null;
  const group = catalogGroupOf(first);
  if (group === 'more') return null;
  if (packs.some((p) => catalogGroupOf(p) !== group)) return null;
  return CATALOG_GROUP_HEADING[group];
}

/**
 * The languages a selection can narrow to: none unless its packs carry two or
 * more (`PACK_LANGUAGE_ORDER`). Each keeps the packs in that language plus the
 * packs with none (`shelfPacks`), in the order given.
 */
export function languageCuts(packs: Pack[]): StageLanguageCut[] {
  const languages = PACK_LANGUAGE_ORDER.filter((l) =>
    packs.some((p) => p.language === l),
  );
  if (languages.length < 2) return [];
  const shelf: PackShelf = { type: null, packs, languages };
  return languages.map((l) => ({
    key: l,
    label: PACK_LANGUAGE_LABEL[l],
    short: l.toUpperCase(),
    ids: shelfPacks(shelf, l).map((p) => p.id),
  }));
}

/**
 * A category's chips as plain data for the client: "All" (every pack), then
 * one per pack type in `shelvePacks` order (untagged packs under "Other"),
 * only when there are two or more type shelves. Every list keeps the stage's
 * walking order (`ordered`).
 */
export function toStageShelves(ordered: Pack[]): StageShelf[] {
  const all: StageShelf = {
    key: ALL_SHELF,
    label: 'All',
    caption: null,
    count: ordered.length,
    ids: ordered.map((p) => p.id),
    languages: languageCuts(ordered),
  };
  const shelves = shelvePacks(ordered);
  if (shelves.length < 2) return [all];
  return [
    all,
    ...shelves.map((s) => {
      // The stage's order, not the shelf's own (both cheapest first today).
      const mine = ordered.filter((p) => (p.packType ?? null) === s.type);
      return {
        key: s.type ?? 'other',
        label: s.type ? PACK_TYPE_LABEL[s.type] : 'Other',
        caption: shelfCaption(mine),
        count: mine.length,
        ids: mine.map((p) => p.id),
        languages: languageCuts(mine),
      };
    }),
  ];
}

/**
 * Every category that has packs, in catalogue order, each in the stage's
 * walking order, with its chips. Empty categories are left out: their tab is
 * the disabled "Coming soon" one and they have no panel.
 */
export function toStageCategories(
  categories: PackCategory[],
  chaseByPack: ReadonlyMap<string, PackCard | null>,
  art3dOf: Art3dLookup = catalogueArt,
): StageCategory[] {
  return categories
    .filter((c) => c.packs.length > 0)
    .map((c) => {
      const ordered = orderStagePacks(c.packs);
      return {
        id: c.id,
        packs: ordered.map((p) =>
          toStagePack(p, chaseByPack.get(p.id) ?? null, art3dOf),
        ),
        shelves: toStageShelves(ordered),
      };
    });
}

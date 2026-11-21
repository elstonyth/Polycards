/**
 * Pack stage row filter: which packs the carousel shows for a pack type chip
 * and a language. Pure and client-safe: it only reads the plain shelf data the
 * server computed (`StageCategory.shelves`, built in `stage-packs.ts` from
 * `shelvePacks`, `catalogGroupOf` and `shelfPacks`), so no catalogue rule is
 * repeated here. Nothing is stored and the URL never changes: the page is
 * route-cached and the same for every visitor.
 */
import type { StageCategory, StagePack, StageShelf } from './contract';

/** The "All" chip: every pack, in the stage's order. */
export const ALL_SHELF = 'all';

/**
 * Owner decision (2026-11-19): the carousel starts on its THIRD pack, so both
 * sides of the stage are filled on first view (clamped to the list).
 */
export const STAGE_START_INDEX = 2;

/** Where a row starts: STAGE_START_INDEX (clamped), moved to the nearest pack
 *  in stock if that one is sold out (the earlier one on a tie). A sold-out
 *  pack keeps its place but is never the starting centre; with nothing in
 *  stock, the clamped index itself. */
export function stageStartIndex(
  packs: readonly Pick<StagePack, 'soldOut'>[],
  wanted: number = STAGE_START_INDEX,
): number {
  if (packs.length === 0) return 0;
  const at = Math.max(0, Math.min(packs.length - 1, wanted));
  for (let d = 0; d < packs.length; d++) {
    if (at - d >= 0 && !packs[at - d]?.soldOut) return at - d;
    if (at + d < packs.length && !packs[at + d]?.soldOut) return at + d;
  }
  return at;
}

export type StageFilter = { shelf: string; language: string | null };

export const ALL_FILTER: Readonly<StageFilter> = Object.freeze({
  shelf: ALL_SHELF,
  language: null,
});

export const sameFilter = (a: StageFilter, b: StageFilter): boolean =>
  a.shelf === b.shelf && a.language === b.language;

/** The type chips to show: "All" plus two or more type shelves, else none. */
export function stageChips(c: Pick<StageCategory, 'shelves'>): StageShelf[] {
  return c.shelves.length > 2 ? c.shelves : [];
}

/** The chosen shelf (unknown keys fall back to "All"). */
export function shelfOf(
  c: Pick<StageCategory, 'shelves'>,
  key: string,
): StageShelf | null {
  return c.shelves.find((s) => s.key === key) ?? c.shelves[0] ?? null;
}

/** The language choices for a selection: two or more, or none at all. */
export function languagesOf(
  c: Pick<StageCategory, 'shelves'>,
  f: StageFilter,
): StageShelf['languages'] {
  const langs = shelfOf(c, f.shelf)?.languages ?? [];
  return langs.length > 1 ? langs : [];
}

/**
 * The row's packs for a filter, in the stage's order. "All" with no language
 * is the category's own array (same identity, so the approved row is
 * untouched).
 */
export function rowPacks(c: StageCategory, f: StageFilter): StagePack[] {
  const shelf = shelfOf(c, f.shelf);
  const cut = f.language
    ? languagesOf(c, f).find((l) => l.key === f.language)
    : undefined;
  if (!shelf || (shelf.key === ALL_SHELF && !cut)) return c.packs;
  const ids = new Set(cut ? cut.ids : shelf.ids);
  return c.packs.filter((p) => ids.has(p.id));
}

/**
 * Where a changed row opens: on the pack that was centred if the new row
 * holds it, otherwise by the stage's first-load rule (third pack, clamped,
 * nearest in stock).
 */
export function rowStart(
  next: readonly Pick<StagePack, 'id' | 'soldOut'>[],
  centredId: string | null,
): number {
  const i = centredId === null ? -1 : next.findIndex((p) => p.id === centredId);
  return i >= 0 ? i : stageStartIndex(next);
}

/**
 * What the collapsed trigger says: "All packs", or the chosen type with its
 * caption (the server's CATALOG_GROUP_HEADING text, only where true), and the
 * language when one is set. Every word is server data.
 */
export function filterLabel(
  c: Pick<StageCategory, 'shelves'>,
  f: StageFilter,
): string {
  const shelf = shelfOf(c, f.shelf);
  const parts =
    !shelf || shelf.key === ALL_SHELF
      ? ['All packs']
      : [shelf.label, ...(shelf.caption ? [shelf.caption] : [])];
  const lang = f.language
    ? languagesOf(c, f).find((l) => l.key === f.language)
    : undefined;
  if (lang) parts.push(lang.label);
  return parts.join(' · ');
}

/** A stable key for a row (category, chip, language). */
export const rowKeyOf = (categoryId: string, f: StageFilter): string =>
  `${categoryId}|${f.shelf}|${f.language ?? ''}`;

/** What the live region says once the track rests on a pack. */
export function stageAnnouncement(
  pack: Pick<StagePack, 'name' | 'priceLabel' | 'soldOut'>,
  index: number,
  count: number,
): string {
  return `${pack.name}, ${pack.priceLabel}${pack.soldOut ? ', sold out' : ''}. ${index + 1} of ${count}.`;
}

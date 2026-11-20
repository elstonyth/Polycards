/**
 * Pack stage: the focused pack's keys per pack, size and kind (the trimmed
 * `focus-poses.json` beside this file, from plan-focus-ciao). Loaded with
 * the focus chunk and the runtime, never in the first load.
 *
 * - A card pack with pull odds: Front, Top Hits, Pull Odds, Buyback, Recent
 *   Pulls, Closing (the back at the two lit stops).
 * - A capsule: Front, Top Hits, Pull Odds, Recent Pulls, Closing; never a
 *   back, Pull Odds docked as Top Hits with a held lean.
 * - A pack with no pull odds: Front, Top Hits, Recent Pulls, Closing; never a
 *   back (the no-odds rule).
 */
import type { FocusKey, StageStopKind } from './contract';
import POSES from './focus-poses.json';

type JsonPose = {
  face: string;
  cx: number;
  cy: number;
  long: number;
  rz: number;
  ry: number;
  rx: number;
  on: number;
};
type JsonPack = {
  plate: number[];
  litRects: Record<'odds' | 'buyback', FocusKey['rect']>;
  desktop: Record<StageStopKind, JsonPose>;
  phone: Record<StageStopKind, JsonPose>;
};

const PACKS = POSES.packs as unknown as Record<string, JsonPack>;
/** The poses a pack not in the table (a capsule) borrows. */
const FALLBACK = '151';
/** A capsule's held lean at its Pull Odds stop (plan section 2), degrees. */
const CAPSULE_ODDS_LEAN = -10;

export type FocusVariant = 'sleeve' | 'capsule' | 'noOdds';

export const FOCUS_DURATIONS = POSES.durations;
export const FOCUS_WINDOW = POSES.window;

/** The stop kinds of a variant, in order. */
export function focusStops(variant: FocusVariant): StageStopKind[] {
  if (variant === 'capsule') return POSES.variants.capsule as StageStopKind[];
  if (variant === 'noOdds') return POSES.variants.noOdds as StageStopKind[];
  return POSES.stops as StageStopKind[];
}

/** The plate size (px) a pack's back is printed from (its full plate). */
export function focusPlate(slug: string): [number, number] | null {
  const p = PACKS[slug]?.plate;
  return p && p.length === 2 ? [p[0]!, p[1]!] : null;
}

/** The focused pack's keys for one size, in stop order. */
export function focusKeys(
  slug: string,
  desktop: boolean,
  variant: FocusVariant,
): FocusKey[] {
  const pack = PACKS[slug] ?? PACKS[FALLBACK]!;
  const table = desktop ? pack.desktop : pack.phone;
  return focusStops(variant).map((kind) => {
    const src =
      variant === 'capsule' && kind === 'odds' ? table.tophits : table[kind];
    const back = variant === 'sleeve' && src.face === 'back';
    const key: FocusKey = {
      kind,
      face: back ? 'back' : 'front',
      cx: src.cx,
      cy: src.cy,
      long: src.long,
      rz: src.rz,
      ry: variant === 'capsule' && kind === 'odds' ? CAPSULE_ODDS_LEAN : src.ry,
      rx: src.rx,
      on: back ? src.on : 0,
    };
    if (back && (kind === 'odds' || kind === 'buyback'))
      key.rect = pack.litRects[kind];
    return key;
  });
}

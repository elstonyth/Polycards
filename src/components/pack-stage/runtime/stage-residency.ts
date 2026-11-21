/**
 * Pack stage residency. Pure: no three.js, no DOM,
 * no clock (the caller passes `now`). Decides which packs hold a model and a
 * GPU texture, given the track position, the drag direction, phone or desktop,
 * the promoted centre pack and a byte budget.
 *
 * Rules:
 * - Required: every pack still drawn, |i - track| < reach + 1 (the same reach
 *   `slotOpacity` uses: phone 1, desktop 2), nearest first.
 * - Prefetch: phone one pack in the drag direction (c + dir * 2); desktop one
 *   each side (c +- 3). A prefetch only fills a free slot or replaces a pack
 *   that has not been needed for `protectMs`.
 * - Hysteresis: a resident pack stays until |i - track| > disposeAt (phone 3,
 *   desktop 4), and a pack needed in the last `protectMs` is never evicted for
 *   a prefetch, so swiping back and forth between two packs loads nothing.
 *   `nextDirection` ratchets the drag direction (it flips only after half a
 *   pack of travel the other way), so small wobbles never flip the prefetch.
 * - Caps: never more than `maxResident` packs (phone 4, desktop 7) and never
 *   more than `budgetBytes` (but the centre pack's half front is always
 *   held); when something must give, the furthest and least
 *   needed goes first. A promoted pack holds its full front AND its half
 *   front (demotion is then an instant swap); both count against the budget.
 */
import { STAGE_REACH } from '../stage-pose';

export type ResidencyConfig = {
  /** Packs are drawn while |i - track| < reach + 1. */
  reach: number;
  prefetch: 'direction' | 'both';
  /** A resident pack is dropped once |i - track| > disposeAt (continuous distance). */
  disposeAt: number;
  maxResident: number;
  /** A pack needed this recently is never evicted for a prefetch. */
  protectMs: number;
};

export const RESIDENCY_PHONE: Readonly<ResidencyConfig> = Object.freeze({
  reach: STAGE_REACH.phone,
  prefetch: 'direction',
  disposeAt: 3,
  maxResident: 4,
  protectMs: 2000,
});

export const RESIDENCY_DESKTOP: Readonly<ResidencyConfig> = Object.freeze({
  reach: STAGE_REACH.desktop,
  prefetch: 'both',
  disposeAt: 4,
  maxResident: 7,
  protectMs: 2000,
});

export function residencyConfig(desktop: boolean): Readonly<ResidencyConfig> {
  return desktop ? RESIDENCY_DESKTOP : RESIDENCY_PHONE;
}

/**
 * The free span: nothing is drawn, and only the chosen
 * pack (the track) is kept, so Just Pulled's pictures have the room; the
 * others are staged again with the rise.
 */
export function lapResidency(
  c: Readonly<ResidencyConfig>,
): Readonly<ResidencyConfig> {
  return { ...c, reach: 0, disposeAt: 0, maxResident: 1 };
}

/** Whole-page GPU caps from the plan's table (decimal MB, so on the safe side). */
export const GPU_CAP_PHONE_BYTES = 40e6;
// desktop: room for a whole-host canvas at full ratio on a 4K monitor (~96 MB) plus the textures
export const GPU_CAP_DESKTOP_BYTES = 200e6;

export function gpuCapBytes(desktop: boolean): number {
  return desktop ? GPU_CAP_DESKTOP_BYTES : GPU_CAP_PHONE_BYTES;
}

/** Bytes left for pack textures once the drawing buffer and environment are paid for. */
export function textureBudgetBytes(
  desktop: boolean,
  fixedBytes: number,
): number {
  return Math.max(0, gpuCapBytes(desktop) - fixedBytes);
}

/** RGBA8 with the full mip chain, as the catalogue counts it. */
export function textureBytes(width: number, height: number): number {
  return Math.round((width * height * 4 * 4) / 3);
}

/** Half-size picture of a full front, as the catalogue's half files are cut. */
export function halfSize(width: number, height: number): [number, number] {
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

export type ResidentInfo = {
  /** Last `now` at which this pack was required (drawn). */
  lastNeeded: number;
};

export type ResidencyInput = {
  /** Track indices of the packs that can be 3D (any order, no duplicates). */
  indices: readonly number[];
  track: number;
  direction: -1 | 0 | 1;
  config: Readonly<ResidencyConfig>;
  /** Index to hold at its full front, or null. */
  promote: number | null;
  budgetBytes: number;
  /** GPU bytes of one pack's half or full front. */
  bytes(index: number, res: 'half' | 'full'): number;
  /** Packs resident now. */
  resident: ReadonlyMap<number, ResidentInfo>;
  now: number;
};

export type ResidencyPlan = {
  /** Packs to hold; `full` true = also hold the full front. */
  want: Map<number, { full: boolean }>;
  /** Packs drawn this frame (|i - track| < reach + 1). */
  required: number[];
  /** Packs the caller stamps `lastNeeded = now` on: admitted required and prefetched ones. */
  stamp: number[];
  /** Bytes of `want`. */
  bytes: number;
};

type Candidate = { index: number; rank: number; dist: number };

const RANK_REQUIRED = 0;
const RANK_PROTECTED = 1;
const RANK_PREFETCH = 2;
const RANK_RETAINED = 3;

export function planResidency(input: ResidencyInput): ResidencyPlan {
  const { indices, track, config, resident, now } = input;
  const have = new Set(indices);
  const seen = new Set<number>();
  const list: Candidate[] = [];
  const required: number[] = [];
  const add = (index: number, rank: number, dist = Math.abs(index - track)) => {
    if (seen.has(index) || !have.has(index)) return;
    seen.add(index);
    list.push({ index, rank, dist });
  };

  for (const i of indices) {
    if (Math.abs(i - track) < config.reach + 1) {
      add(i, RANK_REQUIRED);
      required.push(i);
    }
  }
  // The first pack past each end of the required span (stable while the
  // track wobbles inside one pack), drag direction first.
  const below = Math.floor(track - config.reach - 1);
  const above = Math.ceil(track + config.reach + 1);
  const prefetch: number[] = [];
  if (config.prefetch === 'both') {
    if (input.direction < 0) prefetch.push(below, above);
    else prefetch.push(above, below);
  } else if (input.direction !== 0) {
    prefetch.push(input.direction > 0 ? above : below);
  }
  for (const [i, info] of resident) {
    if (seen.has(i) || !have.has(i)) continue;
    if (Math.abs(i - track) > config.disposeAt) continue;
    if (now - info.lastNeeded < config.protectMs) add(i, RANK_PROTECTED);
  }
  prefetch.forEach((i, order) => add(i, RANK_PREFETCH, order));
  for (const [i] of resident) {
    if (Math.abs(i - track) > config.disposeAt) continue;
    add(i, RANK_RETAINED);
  }
  list.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.index - b.index);

  const want = new Map<number, { full: boolean }>();
  const stamp: number[] = [];
  let bytes = 0;
  for (const cand of list) {
    if (want.size >= config.maxResident) break;
    const half = input.bytes(cand.index, 'half');
    const full = input.bytes(cand.index, 'full');
    let entry: { full: boolean } | null = null;
    if (
      cand.index === input.promote &&
      cand.rank === RANK_REQUIRED &&
      bytes + half + full <= input.budgetBytes
    ) {
      entry = { full: true };
      bytes += half + full;
    } else if (
      bytes + half <= input.budgetBytes ||
      // the centre pack (nearest drawn) is always 3D, over budget if need be
      (want.size === 0 && cand.rank === RANK_REQUIRED)
    ) {
      entry = { full: false };
      bytes += half;
    }
    if (!entry) continue;
    want.set(cand.index, entry);
    // Required packs and held prefetch targets are "needed" now; any other
    // resident pack ages, so a stale one can give way to a prefetch.
    if (cand.rank === RANK_REQUIRED || prefetch.includes(cand.index))
      stamp.push(cand.index);
  }
  return { want, required, stamp, bytes };
}

// --- Drag direction, with a ratchet ------------------------------------------

export type DirectionState = { dir: -1 | 0 | 1; anchor: number };

/** Direction flips only after `threshold` packs of travel the other way. */
export const DIRECTION_THRESHOLD = 0.5;

export function initialDirection(track: number): DirectionState {
  return { dir: 0, anchor: track };
}

export function nextDirection(
  s: DirectionState,
  track: number,
  threshold = DIRECTION_THRESHOLD,
): DirectionState {
  if (s.dir === 1) {
    if (track > s.anchor) return { dir: 1, anchor: track };
    if (track < s.anchor - threshold) return { dir: -1, anchor: track };
    return s;
  }
  if (s.dir === -1) {
    if (track < s.anchor) return { dir: -1, anchor: track };
    if (track > s.anchor + threshold) return { dir: 1, anchor: track };
    return s;
  }
  if (track > s.anchor + threshold) return { dir: 1, anchor: track };
  if (track < s.anchor - threshold) return { dir: -1, anchor: track };
  return s;
}

// --- Full-front promotion of the centred pack (desktop, DPR >= 1.5) ----------

export const PROMOTE_AFTER_MS = 300;
export const PROMOTE_MIN_DPR = 1.5;
/** The track counts as settled when this close to a whole pack and this still. */
const SETTLE_OFFSET = 1e-3;
const SETTLE_STILL = 1e-4;

export type PromotionState = {
  /** The promoted pack, or null. */
  index: number | null;
  /** When the track settled (null while moving). */
  since: number | null;
  lastTrack: number | null;
};

export const NO_PROMOTION: Readonly<PromotionState> = Object.freeze({
  index: null,
  since: null,
  lastTrack: null,
});

/**
 * The centred pack is promoted `PROMOTE_AFTER_MS` after the track settles on
 * it, and demoted once it is no longer the centred pack (|track - i| >= 0.5).
 */
export function nextPromotion(
  s: Readonly<PromotionState>,
  track: number,
  now: number,
  enabled: boolean,
): PromotionState {
  if (!enabled) return { index: null, since: null, lastTrack: track };
  const c = Math.round(track);
  const still =
    s.lastTrack !== null &&
    Math.abs(track - s.lastTrack) < SETTLE_STILL &&
    Math.abs(track - c) < SETTLE_OFFSET;
  const since = still ? (s.since ?? now) : null;
  let index =
    s.index !== null && Math.abs(track - s.index) < 0.5 ? s.index : null;
  if (since !== null && now - since >= PROMOTE_AFTER_MS) index = c;
  return { index, since, lastTrack: track };
}

/** Whether a promotion is still on its way (the caller keeps frames coming). */
export function promotionPending(
  s: Readonly<PromotionState>,
  track: number,
  enabled: boolean,
): boolean {
  return enabled && s.index !== Math.round(track);
}

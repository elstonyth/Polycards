// Pure read-model over the ladder buffer: how the 100 rows chunk into decades
// and where the ladder actually *changes*. Presentation only — nothing here
// feeds the save payload, which still serialises every row in order.
import { FRAME_LEVELS, type VipLevelRow } from './vip-levels-validate-client';

export const DECADE = 10;

export interface DecadeGroup<T> {
  /** 0-based decade index; also the disclosure key. */
  key: number;
  /** Absolute index of this group's first row in the full buffer. */
  startIndex: number;
  firstLevel: number;
  lastLevel: number;
  rows: T[];
  thresholdFrom: string;
  thresholdTo: string;
  /** Distinct box tiers in this decade, in first-seen order. */
  tiers: string[];
  /** Levels inside this decade that unlock a frame. */
  frameLevels: number[];
}

export const groupByDecade = <T extends VipLevelRow>(
  rows: T[],
): DecadeGroup<T>[] => {
  const groups: DecadeGroup<T>[] = [];
  for (let start = 0; start < rows.length; start += DECADE) {
    const slice = rows.slice(start, start + DECADE);
    const tiers: string[] = [];
    const frameLevels: number[] = [];
    slice.forEach((r, j) => {
      if (!tiers.includes(r.boxTier)) tiers.push(r.boxTier);
      if (r.frameUnlock) frameLevels.push(start + j + 1);
    });
    groups.push({
      key: start / DECADE,
      startIndex: start,
      firstLevel: start + 1,
      lastLevel: start + slice.length,
      rows: slice,
      thresholdFrom: slice[0].thresholdInput,
      thresholdTo: slice[slice.length - 1].thresholdInput,
      tiers,
      frameLevels,
    });
  }
  return groups;
};

export interface TierSegment {
  tier: string;
  from: number;
  to: number;
}

export interface LadderShape {
  count: number;
  topThreshold: string;
  /** Consecutive runs of the same box tier — the ladder's real structure. */
  tierSegments: TierSegment[];
  /** Decade levels that exist in this ladder (candidate frame slots). */
  frameSlots: number[];
  /** Of those, the ones actually unlocking a frame. */
  frameLevels: number[];
}

export const ladderShape = (rows: VipLevelRow[]): LadderShape => {
  const tierSegments: TierSegment[] = [];
  const frameLevels: number[] = [];
  rows.forEach((r, i) => {
    const level = i + 1;
    const last = tierSegments[tierSegments.length - 1];
    if (last && last.tier === r.boxTier) last.to = level;
    else tierSegments.push({ tier: r.boxTier, from: level, to: level });
    if (r.frameUnlock) frameLevels.push(level);
  });
  return {
    count: rows.length,
    topThreshold: rows.length ? rows[rows.length - 1].thresholdInput : '0',
    tierSegments,
    frameSlots: FRAME_LEVELS.filter((l) => l <= rows.length),
    frameLevels,
  };
};

/**
 * Which decades a validation error belongs to, read back out of the message
 * text ("Level 63: ..."). Collapsing must never hide a blocking error, so the
 * tab force-opens these groups. Messages without a level (e.g. "The ladder
 * must have at least 1 level.") simply match nothing.
 */
export const decadesWithErrors = (errors: string[]): Set<number> => {
  const decades = new Set<number>();
  for (const e of errors) {
    const m = /Level (\d+)/.exec(e);
    if (m) decades.add(Math.floor((Number(m[1]) - 1) / DECADE));
  }
  return decades;
};

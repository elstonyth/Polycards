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
  /** Levels inside this decade that unlock a frame. */
  frameLevels: number[];
}

export const groupByDecade = <T extends VipLevelRow>(
  rows: T[],
): DecadeGroup<T>[] => {
  const groups: DecadeGroup<T>[] = [];
  for (let start = 0; start < rows.length; start += DECADE) {
    const slice = rows.slice(start, start + DECADE);
    const frameLevels: number[] = [];
    slice.forEach((r, j) => {
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
      frameLevels,
    });
  }
  return groups;
};

export interface LadderShape {
  count: number;
  topThreshold: string;
  /** Decade levels that exist in this ladder (candidate frame slots). */
  frameSlots: number[];
  /** Of those, the ones actually unlocking a frame. */
  frameLevels: number[];
}

export const ladderShape = (rows: VipLevelRow[]): LadderShape => {
  const frameLevels: number[] = [];
  rows.forEach((r, i) => {
    if (r.frameUnlock) frameLevels.push(i + 1);
  });
  return {
    count: rows.length,
    topThreshold: rows.length ? rows[rows.length - 1].thresholdInput : '0',
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

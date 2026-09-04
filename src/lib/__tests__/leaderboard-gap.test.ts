import { describe, it, expect } from 'vitest';
import { findOwnRow, gapLockup, rankGap } from '../leaderboard-gap';
import type { LeaderboardEntry, OwnWeekly } from '../data/leaderboard';

/** Minimal board row — only rank/handle/seed/volumeMyr matter to rankGap. */
function row(
  rank: number,
  handle: string | null,
  volumeMyr: number,
  seed = rank * 1000,
): LeaderboardEntry {
  return {
    rank,
    name: handle ?? 'Collector',
    handle,
    volume: `RM ${volumeMyr.toFixed(2)}`,
    volumeMyr,
    pulls: '1',
    seed,
    avatar: '',
    frame: null,
  };
}

const mine = (volumeMyr: number, pulls: number, seed = -1): OwnWeekly => ({
  volumeMyr,
  pulls,
  seed,
});

const BOARD = [
  row(1, 'moonbreon', 15437.54),
  row(2, 'dada', 13400.58),
  row(3, 'rocket', 8098.97),
  row(10, 'ricardo', 3492.78),
];

describe('findOwnRow', () => {
  it('matches on the seed even when the row has no handle yet', () => {
    // Handles are assigned lazily on a player's first render, so a genuine
    // top-10 row can carry handle: null for one 30s board window. Matching on
    // the handle alone told a player at #3 they were not on the board.
    const board = [row(1, 'a', 100), row(2, null, 50, 777)];
    expect(findOwnRow(board, null, mine(50, 1, 777))?.row.rank).toBe(2);
  });

  it('falls back to the handle when the own-standing hop failed', () => {
    expect(findOwnRow(BOARD, 'rocket', null)?.row.rank).toBe(3);
  });

  it('is null for someone not on the board', () => {
    expect(findOwnRow(BOARD, 'nobody', mine(10, 1, 999))).toBeNull();
  });
});

describe('rankGap', () => {
  it('leader: reports the lead over the runner-up, never a gap', () => {
    expect(rankGap(BOARD, 'moonbreon', null)).toEqual({
      kind: 'leader',
      leadMyr: 2036.96,
    });
  });

  it('leader on a one-row board: no runner-up to lead by', () => {
    expect(rankGap([BOARD[0]!], 'moonbreon', null)).toEqual({
      kind: 'leader',
      leadMyr: null,
    });
  });

  it('on the board: gap to the rank directly above, from board rows alone', () => {
    // Own weekly deliberately absent — an in-board gap must not need the hop.
    expect(rankGap(BOARD, 'rocket', null)).toEqual({
      kind: 'climb',
      toRank: 2,
      gapMyr: 5301.61,
    });
  });

  it('tie with the row above: says nothing, because RM 0.00 would not pass it', () => {
    // The backend breaks ties on customer_id ASC, so equalling the row above
    // never overtakes it. Rounding folds in: a real RM 0.004 gap prints 0.00.
    const tied = [row(1, 'a', 100), row(2, 'b', 100)];
    expect(rankGap(tied, 'b', null)).toEqual({ kind: 'none' });
  });

  it('off the board with pulls: gap to the last shown rank', () => {
    expect(rankGap(BOARD, 'nobody', mine(3079.88, 4))).toEqual({
      kind: 'enter',
      toRank: 10,
      gapMyr: 412.9,
    });
  });

  it('off the board, zero pulls this week: no gap, keep the invitation', () => {
    expect(rankGap(BOARD, 'nobody', mine(0, 0))).toEqual({ kind: 'none' });
  });

  it('off the board, own standing unavailable: says nothing', () => {
    expect(rankGap(BOARD, 'nobody', null)).toEqual({ kind: 'none' });
  });

  it('off the board yet out-pulling the last row: invents no 0', () => {
    // The board is memoised 30s while the own figure is live, and the disabled
    // filter re-numbers over survivors — both make the two sides disagree.
    expect(rankGap(BOARD, 'nobody', mine(9999, 9))).toEqual({ kind: 'none' });
    expect(rankGap(BOARD, 'nobody', mine(3492.78, 9))).toEqual({
      kind: 'none',
    });
  });

  it('logged out or empty board: says nothing', () => {
    expect(rankGap(BOARD, null, null)).toEqual({ kind: 'none' });
    expect(rankGap([], 'moonbreon', mine(500, 2))).toEqual({ kind: 'none' });
  });

  it('does not leak float noise into the money figure', () => {
    const noisy = [row(1, 'a', 0.3), row(2, 'b', 0.1)];
    expect(rankGap(noisy, 'b', null)).toEqual({
      kind: 'climb',
      toRank: 1,
      gapMyr: 0.2,
    });
  });
});

describe('gapLockup', () => {
  it('renders the Sticky Stat Card lockup DESIGN.md specifies', () => {
    expect(gapLockup(rankGap(BOARD, 'rocket', null))).toEqual({
      label: 'TO #2',
      value: 'RM 5,301.61',
    });
    expect(gapLockup(rankGap(BOARD, 'nobody', mine(3079.88, 4)))).toEqual({
      label: 'TO TOP 10',
      value: 'RM 412.90',
    });
    expect(gapLockup(rankGap(BOARD, 'moonbreon', null))).toEqual({
      label: 'LEAD',
      value: 'RM 2,036.96',
    });
  });

  it('names the rank a shortened board actually ends on', () => {
    // The disabled filter can leave the board fewer than 10 rows long; "TOP 10"
    // would then point at a rank nobody holds.
    const short = [row(1, 'a', 100), row(2, 'b', 50)];
    expect(gapLockup(rankGap(short, 'nobody', mine(20, 1)))).toEqual({
      label: 'TO #2',
      value: 'RM 30.00',
    });
  });

  it('is null when there is nothing to state', () => {
    expect(gapLockup({ kind: 'none' })).toBeNull();
    expect(gapLockup({ kind: 'leader', leadMyr: null })).toBeNull();
  });
});

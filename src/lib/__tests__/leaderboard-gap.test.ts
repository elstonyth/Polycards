import { describe, it, expect } from 'vitest';
import { rankGap } from '../leaderboard-gap';
import type { LeaderboardEntry } from '../data/leaderboard';

/** Minimal board row — only rank/handle/volumeMyr matter to rankGap. */
function row(
  rank: number,
  handle: string,
  volumeMyr: number,
): LeaderboardEntry {
  return {
    rank,
    name: handle,
    handle,
    volume: `RM ${volumeMyr.toFixed(2)}`,
    volumeMyr,
    pulls: '1',
    avatar: '',
    frame: null,
  };
}

const BOARD = [
  row(1, 'moonbreon', 15437.54),
  row(2, 'dada', 13400.58),
  row(3, 'rocket', 8098.97),
  row(10, 'ricardo', 3492.78),
];

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

  it('tie: a gap of exactly 0 is a real state (ties break on customer id)', () => {
    const tied = [row(1, 'a', 100), row(2, 'b', 100)];
    expect(rankGap(tied, 'b', null)).toEqual({
      kind: 'climb',
      toRank: 1,
      gapMyr: 0,
    });
  });

  it('off the board with pulls: gap to the last shown rank', () => {
    expect(rankGap(BOARD, 'nobody', { volumeMyr: 3079.88, pulls: 4 })).toEqual({
      kind: 'enter',
      toRank: 10,
      gapMyr: 412.9,
    });
  });

  it('off the board, zero pulls this week: no gap, keep the invitation', () => {
    expect(rankGap(BOARD, 'nobody', { volumeMyr: 0, pulls: 0 })).toEqual({
      kind: 'none',
    });
  });

  it('off the board, own standing unavailable: says nothing', () => {
    expect(rankGap(BOARD, 'nobody', null)).toEqual({ kind: 'none' });
  });

  it('off the board yet out-pulling the last row: says nothing, invents no 0', () => {
    // Real case, hit in local capture: a player’s public handle is assigned on
    // their first page render, so for one 30s board window their row carries a
    // null handle and cannot be matched — the true #3 fell into this branch and
    // an earlier clamp rendered "RM 0.00 to top 10" at them.
    expect(rankGap(BOARD, 'nobody', { volumeMyr: 9999, pulls: 9 })).toEqual({
      kind: 'none',
    });
    // Equal to the last row is the same disagreement, not a 0-gap standing.
    expect(rankGap(BOARD, 'nobody', { volumeMyr: 3492.78, pulls: 9 })).toEqual({
      kind: 'none',
    });
  });

  it('logged out or empty board: says nothing', () => {
    expect(rankGap(BOARD, null, { volumeMyr: 500, pulls: 2 })).toEqual({
      kind: 'none',
    });
    expect(rankGap([], 'moonbreon', { volumeMyr: 500, pulls: 2 })).toEqual({
      kind: 'none',
    });
  });

  it('does not leak float noise into the money figure', () => {
    const noisy = [row(1, 'a', 0.3), row(2, 'b', 0.1)];
    const gap = rankGap(noisy, 'b', null);
    expect(gap).toEqual({ kind: 'climb', toRank: 1, gapMyr: 0.2 });
  });
});

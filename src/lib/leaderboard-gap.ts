/**
 * "How far off the next rank am I" for the weekly standings.
 *
 * Pure: every input is already on the page (the top-10 rows, the caller's
 * handle, and the caller's own weekly figure from GET /store/leaderboard/me).
 *
 * WEEKLY ONLY. On All Time the board ranks by pack-open SPEND while the figure
 * it displays is pulled VALUE, so the difference between two adjacent All Time
 * rows is not the amount that separates them and can even be negative. The
 * number that would be meaningful there is spend, which is deliberately not
 * shown. Callers gate on the period; this module does not guess.
 */
import type { LeaderboardEntry, OwnWeekly } from '@/lib/data/leaderboard';

export type RankGap =
  /** On the board at #1. `leadMyr` is null when there is no runner-up yet. */
  | { kind: 'leader'; leadMyr: number | null }
  /** On the board below #1: `gapMyr` more pulled value reaches `toRank`. */
  | { kind: 'climb'; toRank: number; gapMyr: number }
  /** Off the board, but ripping this week: `gapMyr` reaches the last shown rank. */
  | { kind: 'enter'; gapMyr: number; toRank: number }
  /** Nothing honest to say — logged out, empty board, no pulls this week, or
   *  the own-standing hop failed. The card keeps the copy it shows today. */
  | { kind: 'none' };

const NONE: RankGap = { kind: 'none' };

export function rankGap(
  entries: LeaderboardEntry[],
  ownHandle: string | null,
  ownWeekly: OwnWeekly | null,
): RankGap {
  if (ownHandle == null || entries.length === 0) return NONE;

  const i = entries.findIndex((e) => e.handle === ownHandle);

  if (i === 0) {
    const runnerUp = entries[1];
    return {
      kind: 'leader',
      leadMyr: runnerUp
        ? round2(entries[0]!.volumeMyr - runnerUp.volumeMyr)
        : null,
    };
  }

  if (i > 0) {
    // Both figures come from the SAME board response, so the subtraction can't
    // straddle two fetches. A gap of exactly 0 is real, not a bug: the backend
    // breaks ties on customer id, so you can equal the rank above and still sit
    // below it.
    const above = entries[i - 1]!;
    return {
      kind: 'climb',
      toRank: above.rank,
      gapMyr: round2(above.volumeMyr - entries[i]!.volumeMyr),
    };
  }

  // Off the board. Without the caller's own figure there is no gap to state.
  if (ownWeekly == null) return NONE;
  // Zero pulls this week is a cold start, not a near miss — the card keeps its
  // invitation rather than quoting the whole #10 figure as a wall. `pulls`, not
  // volume: an unstamped pull with no price on file also sums to 0.
  if (ownWeekly.pulls <= 0) return NONE;

  const last = entries[entries.length - 1]!;
  const gapMyr = round2(last.volumeMyr - ownWeekly.volumeMyr);
  // Out-pulling the last shown row while sitting off the board is not a real
  // standing — it means the two sides disagree, and the card must not invent a
  // number across that disagreement. Three ways it happens, all transient or
  // display-only: the board is memoised 30s while this figure is live; a
  // player's public handle is assigned lazily on their first page render, so
  // for one board window their row carries a null handle and cannot be matched
  // to them; and the disabled filter re-numbers over survivors. Saying nothing
  // returns the card to the copy it shows today — quoting "RM 0.00 to top 10"
  // at someone who is actually #3 does not.
  if (gapMyr <= 0) return NONE;
  return { kind: 'enter', toRank: last.rank, gapMyr };
}

/** Sen precision — the figures are MYR, and float subtraction of two rounded
 *  values otherwise surfaces as "RM 88.19999999999999". */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

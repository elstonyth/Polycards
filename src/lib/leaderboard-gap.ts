/**
 * "How far off the next rank am I" for the weekly standings.
 *
 * Pure: every input is already on the page (the top-10 rows, the caller's
 * identity, and the caller's own weekly figure from GET /store/leaderboard/me).
 *
 * WEEKLY ONLY. On All Time the board ranks by pack-open SPEND while the figure
 * it displays is pulled VALUE, so the difference between two adjacent All Time
 * rows is not the amount that separates them and can even be negative. The
 * number that would be meaningful there is spend, which is deliberately not
 * shown. Callers gate on the period; this module does not guess.
 */
import { rm } from '@/lib/format';
import type { LeaderboardEntry, OwnWeekly } from '@/lib/data/leaderboard';

export type RankGap =
  /** On the board at #1. `leadMyr` is null when there is no runner-up yet. */
  | { kind: 'leader'; leadMyr: number | null }
  /** On the board below #1: `gapMyr` more pulled value reaches `toRank`. */
  | { kind: 'climb'; toRank: number; gapMyr: number }
  /** Off the board, but ripping this week: `gapMyr` reaches the last shown rank. */
  | { kind: 'enter'; gapMyr: number; toRank: number }
  /** Nothing honest to say — logged out, empty board, no pulls this week, a
   *  tie the tie-break already settled, or the own-standing hop failed. The
   *  card keeps the copy it shows today. */
  | { kind: 'none' };

const NONE: RankGap = { kind: 'none' };

/**
 * The caller's own row on the board, or null when they are not on it.
 *
 * Matches on the PII-safe avatar seed first and the public handle second. The
 * seed is derived from the customer id and is present on every row from the
 * moment it exists; a handle is assigned lazily by the ensure-profile-handle
 * workflow on the player's first page render, so for one 30s board window a
 * genuine top-10 row can carry `handle: null` and match nobody. Matching on the
 * handle alone told a player sitting at #3 they were not on the board.
 *
 * Exported because the card reads the same row for the rank and pulled figures
 * it prints — two lookups that could disagree would put "Not on the board yet"
 * above a gap to #3.
 */
export function findOwnRow(
  entries: LeaderboardEntry[],
  ownHandle: string | null,
  ownWeekly: OwnWeekly | null,
): { row: LeaderboardEntry; index: number } | null {
  const seed = ownWeekly?.seed ?? null;
  const i = entries.findIndex(
    (e) =>
      (seed != null && e.seed === seed) ||
      (ownHandle != null && e.handle === ownHandle),
  );
  return i < 0 ? null : { row: entries[i]!, index: i };
}

export function rankGap(
  entries: LeaderboardEntry[],
  ownHandle: string | null,
  ownWeekly: OwnWeekly | null,
): RankGap {
  if (entries.length === 0) return NONE;
  if (ownHandle == null && ownWeekly == null) return NONE;

  const own = findOwnRow(entries, ownHandle, ownWeekly);

  if (own?.index === 0) {
    const runnerUp = entries[1];
    return {
      leadMyr: runnerUp ? round2(own.row.volumeMyr - runnerUp.volumeMyr) : null,
      kind: 'leader',
    };
  }

  if (own != null) {
    // Both figures come from the SAME board response, so the subtraction can't
    // straddle two fetches.
    const above = entries[own.index - 1]!;
    const gapMyr = round2(above.volumeMyr - own.row.volumeMyr);
    // Equalling the row above does not pass it — the backend breaks ties on
    // customer id — so "RM 0.00 to #8" states an amount that would not work.
    // Rounding folds in here too: a real RM 0.004 gap prints as RM 0.00.
    if (gapMyr <= 0) return NONE;
    return { kind: 'climb', toRank: above.rank, gapMyr };
  }

  // Off the board. Without the caller's own figure there is no gap to state.
  if (ownWeekly == null) return NONE;
  // Zero pulls this week is a cold start, not a near miss — the card keeps its
  // invitation rather than quoting the whole #10 figure as a wall. `pulls`, not
  // volume: an unstamped pull with no price on file also sums to 0.
  if (ownWeekly.pulls <= 0) return NONE;

  const last = entries[entries.length - 1]!;
  const gapMyr = round2(last.volumeMyr - ownWeekly.volumeMyr);
  // Out-pulling the last shown row while sitting off the board means the two
  // sides disagree, and the card must not invent a number across that: the
  // board is memoised 30s while this figure is live, and the disabled filter
  // re-numbers over survivors. Same refusal as the tie above.
  if (gapMyr <= 0) return NONE;
  return { kind: 'enter', toRank: last.rank, gapMyr };
}

/**
 * The gap as the Sticky Stat Card renders it: an uppercase stat label and a
 * Nekst Black value, matching the lockup DESIGN.md §"Signature: Sticky Stat
 * Card" specifies for this exact card ("YOUR RANK #458 / TO TOP 10 RM 29,701 /
 * [Buy Now]" — "Label row in uppercase Label style, values in Nekst Black").
 * Null when there is nothing honest to state, and the card falls back to the
 * copy it shows today.
 *
 * Lives here, beside rankGap, because picking the words IS the behaviour — the
 * "TOP 10" vs "#N" choice below is a real branch, and a branch in a component
 * is a branch nothing covers.
 */
export function gapLockup(
  gap: RankGap,
): { label: string; value: string } | null {
  switch (gap.kind) {
    case 'climb':
      return { label: `TO #${gap.toRank}`, value: rm(gap.gapMyr) };
    case 'leader':
      // A board of one has nobody to lead: the card keeps its rank and pulled
      // figures and states no lead rather than inventing one.
      return gap.leadMyr == null
        ? null
        : { label: 'LEAD', value: rm(gap.leadMyr) };
    case 'enter':
      // "TOP 10" reads better than "#10" for the common full board — and is
      // the label DESIGN.md names. A board shortened by the disabled filter
      // names the rank it actually ends on.
      return {
        label: gap.toRank === 10 ? 'TO TOP 10' : `TO #${gap.toRank}`,
        value: rm(gap.gapMyr),
      };
    default:
      return null;
  }
}

/** Sen precision — the figures are MYR, and float subtraction of two rounded
 *  values otherwise surfaces as "RM 88.19999999999999". */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

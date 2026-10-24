/**
 * Lucky Draw — pure helpers for the /lucky-draw page (spec
 * docs/superpowers/specs/2026-10-24-lucky-draw-design.md §5, §9, §10).
 *
 * No zod, no store, no React: client components import this, so it must not
 * drag the data layer into their bundle.
 */

/** Why the enter route turned an entry away (backend `EnterRefusal`). */
export const ENTER_REFUSALS = [
  'not_found',
  'not_open',
  'closed',
  'not_enough_tickets',
  'no_topup',
] as const;
export type EnterRefusal = (typeof ENTER_REFUSALS)[number];

export const ENTER_REFUSAL_COPY: Record<EnterRefusal, string> = {
  not_found: 'This prize is no longer available.',
  not_open: 'This Lucky Draw has not started yet.',
  closed: 'Entries for this prize are closed.',
  not_enough_tickets: "You don't have that many tickets.",
  no_topup: 'Top up at least once to enter the Lucky Draw.',
};

/** A refusal this build does not know yet (deploy skew) still gets a sentence. */
export const refusalCopy = (reason: string): string =>
  ENTER_REFUSAL_COPY[reason as EnterRefusal] ??
  'Could not enter this prize. Please try again later.';

/** The most tickets one entry may carry (backend MAX_ENTRY_TICKETS). */
export const MAX_ENTRY_TICKETS = 1_000_000;

/** My chance on a prize: '0%' with nothing in, '<0.1%' for a sliver, one
 *  decimal under 10%, a whole number above — never '100%' while anyone else
 *  holds a ticket. */
export function chancePercent(mine: number, total: number): string {
  if (!(total > 0) || !(mine > 0)) return '0%';
  const p = (mine / total) * 100;
  if (p < 0.1) return '<0.1%';
  const tenth = Math.round(p * 10) / 10;
  if (tenth < 10) return `${tenth.toFixed(1)}%`;
  return `${Math.min(mine < total ? 99 : 100, Math.round(p))}%`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Time left to a draw: '2d 4h', '3h 05m', '4m 09s', then 'Drawing…'. Seconds
 *  round UP, so the label never says Drawing… before the draw time. */
export function drawCountdown(drawAtIso: string, nowMs: number): string {
  const ms = Date.parse(drawAtIso) - nowMs;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Drawing…';
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

/** Each entry's tickets as an inclusive range, counted from 0 through the list
 *  in its order — the draw order the fair-draw check walks. */
export function ticketRanges(
  entries: { tickets: number }[],
): { start: number; end: number }[] {
  let next = 0;
  return entries.map(({ tickets }) => {
    const start = next;
    next += tickets;
    return { start, end: next - 1 };
  });
}

/** The entry holding the winning ticket, or -1. By ticket, never by name:
 *  disabled accounts all show as "Anonymous". */
export function winnerIndex(
  entries: { tickets: number }[],
  ticketIndex: number | null,
): number {
  if (ticketIndex == null) return -1;
  return ticketRanges(entries).findIndex(
    (r) => ticketIndex >= r.start && ticketIndex <= r.end,
  );
}

/** One wedge of the wheel, in degrees clockwise from 12 o'clock. `index` is
 *  the entry it stands for; null is the merged filler arc. */
export type WheelSegment = { a0: number; a1: number; index: number | null };

/** The most wedges the wheel draws before it merges the smallest. */
export const WHEEL_MAX_SEGMENTS = 300;

/** Wedges sized by tickets, in list order. Above `max` entrants the smallest
 *  (never the winner) merge into one filler arc at the end so the wheel stays
 *  readable; every kept wedge, the winner's included, keeps its true span. */
export function wheelSegments(
  entries: { tickets: number }[],
  winner: number,
  max = WHEEL_MAX_SEGMENTS,
): WheelSegment[] {
  const total = entries.reduce((n, e) => n + e.tickets, 0);
  if (!(total > 0)) return [];
  let kept: Set<number> | null = null;
  if (entries.length > max) {
    const biggest = entries
      .map((e, i) => ({ i, t: e.tickets }))
      .filter(({ i }) => i !== winner)
      .sort((a, b) => b.t - a.t)
      .slice(0, max - (winner >= 0 ? 2 : 1))
      .map(({ i }) => i);
    kept = new Set(winner >= 0 ? [winner, ...biggest] : biggest);
  }
  const segs: WheelSegment[] = [];
  let a = 0;
  let filler = 0;
  entries.forEach((e, i) => {
    if (kept && !kept.has(i)) {
      filler += e.tickets;
      return;
    }
    const span = (e.tickets / total) * 360;
    segs.push({ a0: a, a1: a + span, index: i });
    a += span;
  });
  if (filler > 0) segs.push({ a0: a, a1: 360, index: null });
  return segs;
}

/** Where the pointer lands in a wedge: uniformly inside its middle 56%, so
 *  the stop never looks staged on an edge or dead centre. `rand` is 0..1. */
export const landingAngle = (seg: WheelSegment, rand: number): number =>
  seg.a0 + (seg.a1 - seg.a0) * (0.22 + rand * 0.56);

/** The wedge under the 12 o'clock pointer when the face is turned `rotation`
 *  degrees clockwise. */
export function segmentAt(segs: WheelSegment[], rotation: number): number {
  const a = (((360 - (rotation % 360)) % 360) + 360) % 360;
  return segs.findIndex((s) => a >= s.a0 && a < s.a1);
}

/** Holo foil (DESIGN.md "Holo foil", Lucky Draw only): the wheel rim, the
 *  prize frame and the dust — never chrome or buttons. The one copy of the
 *  stops; CSS reads them through `holoConic`. */
export const HOLO_STOPS = [
  '#c7f0ff',
  '#d8c8ff',
  '#ffc9e6',
  '#e9ecf2',
  '#b8f3ea',
  '#cfd6ff',
  '#ffd6f0',
] as const;

/** The foil as a turning conic gradient (globals.css animates --holo-turn). */
export const holoConic = `conic-gradient(from var(--holo-turn, 0deg), ${[...HOLO_STOPS, HOLO_STOPS[0]].join(', ')})`;

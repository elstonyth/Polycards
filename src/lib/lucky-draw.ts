/**
 * Lucky Draw — pure helpers for the /lucky-draw page (spec
 * docs/superpowers/specs/2026-10-24-lucky-draw-design.md §5, §9, §10).
 *
 * No zod, no store, no React: client components import this, so it must not
 * drag the data layer into their bundle.
 */
import type {
  LuckyDrawEventDetail,
  LuckyDrawResultDetail,
} from '@/lib/data/schemas';

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

/** The sentences that would say "this prize" on a one-winner event. */
const POT_REFUSAL_COPY: Partial<Record<EnterRefusal, string>> = {
  not_found: 'This Lucky Draw is no longer available.',
  closed: 'Entries for this Lucky Draw are closed.',
};

/** A refusal this build does not know yet (deploy skew) still gets a sentence. */
export const refusalCopy = (reason: string, pot = false): string =>
  (pot ? POT_REFUSAL_COPY[reason as EnterRefusal] : undefined) ??
  ENTER_REFUSAL_COPY[reason as EnterRefusal] ??
  (pot
    ? 'Could not enter this Lucky Draw. Please try again later.'
    : 'Could not enter this prize. Please try again later.');

const RULES_START = 'Tickets come from tasks, Lucky Packs and Polycards gifts.';

/** The small print under the page, by the event's rule. */
export const rulesCopy = (mode: 'per_prize' | 'one_winner'): string =>
  mode === 'one_winner'
    ? `${RULES_START} Entering needs at least one top-up, and entries are final: losing tickets are gone, and tickets you keep carry over to the next draw. More tickets means a better chance, and one ticket can still win. When the draw ends, one winner takes every prize: cards go to their vault and sell back like task rewards; credit is bonus credit for packs. The winner is drawn from a seed fixed before entries open. All times are Malaysia time (MYT).`
    : `${RULES_START} Entering needs at least one top-up, and entries are final. Card prizes go to your vault and sell back like task rewards; credit prizes are bonus credit for packs. Every winner is drawn from a seed fixed before entries open. All times are Malaysia time (MYT).`;

/** What /lucky-draw shows. The per-prize page is today's, for any event that
 *  is not one-winner (a card-era payload has no mode). A stored result decides
 *  before the clock, and with no clock yet (the server render) the pot reads
 *  open, so hydration agrees. */
export type LuckyDrawView =
  | 'unavailable'
  | 'coming_soon'
  | 'per_prize'
  | 'pot_open'
  | 'pot_drawing'
  | 'pot_drawn';

export function luckyDrawView(
  page: {
    event: { draw_mode?: string; ends_at: string; result?: unknown } | null;
  } | null,
  nowMs: number | null,
): LuckyDrawView {
  if (!page) return 'unavailable';
  const { event } = page;
  if (!event) return 'coming_soon';
  if (event.draw_mode !== 'one_winner') return 'per_prize';
  if (event.result) return 'pot_drawn';
  return nowMs != null && nowMs >= Date.parse(event.ends_at)
    ? 'pot_drawing'
    : 'pot_open';
}

/** Every prize added up, in sen: 0.1 + 0.2 must not print a float tail. */
export const potTotal = (prizes: { value_myr: number }[]): number =>
  prizes.reduce((sen, p) => sen + Math.round(p.value_myr * 100), 0) / 100;

/** The pot's face: the most valuable card, because the card is the hero; only
 *  a pot with no card shows its biggest credit prize. */
export function heroPrize<T extends { kind?: string; value_myr: number }>(
  prizes: T[],
): T | null {
  const best = (list: T[]) =>
    list.reduce<T | null>(
      (top, p) => (!top || p.value_myr > top.value_myr ? p : top),
      null,
    );
  return best(prizes.filter((p) => p.kind === 'card')) ?? best(prizes);
}

/** The pot in showing order: the hero leads, the rest keep theirs. */
export function heroFirst<T extends { kind?: string; value_myr: number }>(
  prizes: T[],
): T[] {
  const hero = heroPrize(prizes);
  return hero ? [hero, ...prizes.filter((p) => p !== hero)] : prizes;
}

/** A one-winner event as the wheel and the result sheet read a result: named
 *  for the event, worth the pot, wearing the hero's art, its prizes hero first.
 *  The name comes from the caller: the page and the results row both have it. */
export function eventResultDetail(
  eventId: string,
  eventName: string,
  raw: LuckyDrawEventDetail,
): LuckyDrawResultDetail {
  const prizes = heroFirst(raw.prizes);
  return {
    result: {
      ...raw.result,
      prize_id: eventId,
      title: eventName,
      image: prizes[0]?.image ?? null,
      value_myr: potTotal(prizes),
    },
    entries: raw.entries,
    ticket_index: raw.ticket_index,
    prizes,
  };
}

/** The event a results row opens, or null for an old per-prize row. */
export const eventRowId = (row: {
  draw_mode?: string;
  event_id?: string;
}): string | null =>
  row.draw_mode === 'one_winner' && row.event_id ? row.event_id : null;

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

/** The prize wheel's big clock: time left as padded days, hours, minutes,
 *  seconds (seconds round up, as drawCountdown), or null once it is due. */
export function countdownClock(
  drawAtIso: string,
  nowMs: number,
): { d: string; h: string; m: string; s: string } | null {
  const ms = Date.parse(drawAtIso) - nowMs;
  if (!(ms > 0)) return null;
  const s = Math.ceil(ms / 1000);
  return {
    d: pad(Math.floor(s / 86_400)),
    h: pad(Math.floor((s % 86_400) / 3600)),
    m: pad(Math.floor((s % 3600) / 60)),
    s: pad(s % 60),
  };
}

/** What the wheel's hub counts down to: the soonest undrawn prize still
 *  ahead; 'drawing' while a past one waits for its result; else 'done'. */
export function nextDraw(
  prizes: { draw_at: string; result: unknown }[],
  nowMs: number,
): { kind: 'next'; at: string } | { kind: 'drawing' } | { kind: 'done' } {
  const undrawn = prizes.filter((p) => !p.result);
  const ahead = undrawn
    .filter((p) => Date.parse(p.draw_at) > nowMs)
    .sort((a, b) => Date.parse(a.draw_at) - Date.parse(b.draw_at))[0];
  if (ahead) return { kind: 'next', at: ahead.draw_at };
  return undrawn.length > 0 ? { kind: 'drawing' } : { kind: 'done' };
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

/** Whether an entry list can be walked: its tickets add up to the result's
 *  total, and a result with a winner has entries. The schema drops a row it
 *  cannot read, and one missing row shifts every later ticket range — the
 *  wheel would land on, and the list would badge, the wrong entrant. */
export function entriesIntact(
  entries: { tickets: number }[],
  result: { total_tickets: number; winner: unknown },
): boolean {
  const sum = entries.reduce((n, e) => n + e.tickets, 0);
  return (
    sum === result.total_tickets &&
    (result.winner == null || entries.length > 0)
  );
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

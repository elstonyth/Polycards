/**
 * Lucky Draw — pure helpers for the /lucky-draw page (spec
 * docs/superpowers/specs/2026-10-24-lucky-draw-design.md §5, §9, §10).
 *
 * No zod, no store, no React: client components import this, so it must not
 * drag the data layer into their bundle.
 */
import type {
  LuckyDrawEventDetail,
  LuckyDrawGate,
  LuckyDrawPage,
  LuckyDrawResultDetail,
} from '@/lib/data/schemas';
import { mytClock, mytDay, mytDayNumber } from '@/lib/format';

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

const RULES_START = 'Tickets come from tasks, capsules and Polycards gifts.';

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

/** A one-winner event as the arena and the result sheet read a result: named
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
      frame: prizes[0]?.frame ?? null,
      value_myr: potTotal(prizes),
      tier: raw.tier,
    },
    entries: raw.entries,
    ticket_index: raw.ticket_index,
    my_entry_index: raw.my_entry_index,
    prizes,
  };
}

/** A prize's price on a small tile: whole ringgit from RM 1,000 up, so it stays
 *  on one line. The pool's total and the zoomed prize keep the sen. */
export const tilePrice = (value: number): number =>
  value >= 1000 ? Math.round(value) : value;

/** A gate's tier, set by the operator on each gate (boss 2026-11-01): cheap and
 *  short, up to dear and long. A label and a filter; it changes no rule. */
export const LUCKY_DRAW_TIERS = ['economy', 'business', 'first'] as const;
export type LuckyDrawTier = (typeof LUCKY_DRAW_TIERS)[number];

export const TIER_LABEL: Record<LuckyDrawTier, string> = {
  economy: 'Economy',
  business: 'Business',
  first: 'First',
};

/** How much pearl veils the foil on a gate's stub, as a hex alpha: the higher
 *  the class, the more foil shows. Material, not a new colour. */
export const TIER_VEIL: Record<LuckyDrawTier, string> = {
  economy: 'd6',
  business: 'a0',
  first: '4c',
};

/** The running gates on a page. A backend still deploying has no `events`: its
 *  one running one-winner event reads as one gate with no class. */
export function pageGates(page: LuckyDrawPage | null): LuckyDrawGate[] {
  if (!page) return [];
  if (page.events) return page.events;
  const { event } = page;
  if (event?.draw_mode !== 'one_winner' || event.result) return [];
  return [
    {
      id: event.id,
      tier: null,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      total_tickets: event.total_tickets,
      entrant_count: event.entrant_count,
      my_tickets: event.my_tickets,
      top: event.top,
      prizes: page.prizes,
    },
  ];
}

/** A page re-read laid over the one this tab holds. A read can be 10 s old, and a
 *  fresh one drops a gate the moment it is drawn. So a gate this tab has closed
 *  stays gone (its spin must not replay), and one that ended with its result
 *  still unread here stays until its poll answers (its spin must still play). */
export function mergeFreshGates(
  prev: LuckyDrawPage | null,
  fresh: LuckyDrawPage,
  closed: ReadonlySet<string>,
  now: number,
  pollWindowMs: number,
): LuckyDrawPage {
  const gates = pageGates(fresh).filter((g) => !closed.has(g.id));
  const listed = new Set(gates.map((g) => g.id));
  const unread = pageGates(prev).filter((g) => {
    const end = Date.parse(g.ends_at);
    return (
      !closed.has(g.id) &&
      !listed.has(g.id) &&
      now >= end &&
      now < end + pollWindowMs
    );
  });
  return { ...fresh, events: [...gates, ...unread] };
}

/** The gates gone from the page: drawn, with their show over. Until then a ticket
 *  stays up, closed, so it doesn't vanish with nothing on screen while a tab waits
 *  to read the rest of its minute. */
export const gatesGone = (
  drawn: ReadonlySet<string>,
  held: ReadonlySet<string>,
): ReadonlySet<string> => new Set([...drawn].filter((id) => !held.has(id)));

/** When a gate went live: its publish can come after its start. */
const liveAt = (g: { starts_at: string; live_at?: string }): string =>
  g.live_at ?? g.starts_at;

export const GATE_SORTS = {
  closing: 'Closing soon',
  value: 'Biggest prize',
  newest: 'Newest',
} as const;
export type GateSort = keyof typeof GATE_SORTS;

const SORT_ORDER: Record<
  GateSort,
  (a: LuckyDrawGate, b: LuckyDrawGate) => number
> = {
  closing: (a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at),
  value: (a, b) => potTotal(b.prizes) - potTotal(a.prizes),
  newest: (a, b) => Date.parse(liveAt(b)) - Date.parse(liveAt(a)),
};

/** Gates in showing order: a gate new since the last visit on top, then the
 *  chosen sort. The soonest draw leads by default (boss 2026-11-01). */
export function sortGates(
  gates: LuckyDrawGate[],
  sort: GateSort,
  newIds: ReadonlySet<string>,
): LuckyDrawGate[] {
  return [...gates].sort(
    (a, b) =>
      Number(newIds.has(b.id)) - Number(newIds.has(a.id)) ||
      SORT_ORDER[sort](a, b) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** The gates that went live after the last visit. A first visit has nothing to
 *  compare with, so nothing is new: every gate marked NEW would mean nothing. */
export function newGateIds(
  gates: { id: string; starts_at: string; live_at?: string }[],
  seenAt: string | null,
): Set<string> {
  const seen = seenAt ? Date.parse(seenAt) : NaN;
  if (Number.isNaN(seen)) return new Set();
  return new Set(
    gates.filter((g) => Date.parse(liveAt(g)) > seen).map((g) => g.id),
  );
}

const NEAR_DAYS: Record<number, string> = {
  [-1]: 'Yesterday',
  0: 'Today',
  1: 'Tomorrow',
};

/** The day a pool opens or closes. A short pool lives in today and tomorrow, so
 *  the near days are words. With no clock yet (the server render) it is the
 *  plain date, so hydration agrees. */
export function poolDay(iso: string, nowMs: number | null): string {
  const at = Date.parse(iso);
  if (nowMs != null && !Number.isNaN(at)) {
    const near = NEAR_DAYS[mytDayNumber(at) - mytDayNumber(nowMs)];
    if (near) return near;
  }
  return mytDay(iso);
}

/** poolDay and the time, to read inside a sentence. */
export function poolWhen(iso: string, nowMs: number | null): string {
  const day = poolDay(iso, nowMs);
  const inSentence = Object.values(NEAR_DAYS).includes(day)
    ? day.toLowerCase()
    : day;
  return `${inSentence}, ${mytClock(iso)} MYT`;
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

/** What players see every one-winner pool called: pools run too often to name
 *  each one (operator 2026-10-31). The stored event name is the admin's. */
export const POOL_TITLE = 'Prize Pool';

/** My chance as a My entry row says it, or null with none to state: a refunded
 *  pool, an old prize row, a backend still deploying. */
export function entryChance(entry: {
  status: string;
  my_tickets: number;
  total_tickets?: number;
}): string | null {
  if (entry.status === 'cancelled' || !entry.total_tickets) return null;
  const chance = chancePercent(entry.my_tickets, entry.total_tickets);
  return entry.status === 'open'
    ? `${chance} chance`
    : `had a ${chance} chance`;
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
 *  arena would end on, and the list would badge, the wrong entrant. */
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

/** Holo foil (DESIGN.md "Holo foil", Lucky Draw only): the arena's rim and chips,
 *  the prize frame and the dust — never chrome or buttons. The one copy of the
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

/** The foil as a sheet, for a surface: a conic pinches to a point when you can
 *  see its middle, so this one slides its light across instead. Under a pearl
 *  veil, as on the ticket art: at full strength a whole surface of it reads as
 *  candy, and it is meant to be a premium card's shimmer. */
export const holoSheet = (veil = 'a0') =>
  `linear-gradient(${HOLO_STOPS[3]}${veil}, ${HOLO_STOPS[3]}${veil}), linear-gradient(calc(115deg + var(--holo-turn, 0deg)), ${HOLO_STOPS.join(', ')})`;

// The Lucky Draw console's one-winner rules (spec 2026-10-30): which screens an
// event gets, where it is in its life, what may still change and whether its
// window makes sense. Split out of page.tsx for the reason lucky-draw-draft.ts
// is — the admin vitest runner has no DOM.
import type {
  AdminLuckyDrawEvent,
  AdminLuckyDrawPrize,
} from '../../lib/admin-rest';
import { toIso } from '../tasks/task-draft';
import {
  LUCKY_DRAW_MIN_LEAD_MS,
  OVERDUE_AFTER_MS,
  prizeState,
  type EventDraft,
  type PrizeState,
} from './lucky-draw-draft';

type DrawMode = Pick<AdminLuckyDrawEvent, 'status' | 'draw_mode'>;
type EventClock = Pick<
  AdminLuckyDrawEvent,
  'status' | 'starts_at' | 'ends_at' | 'prizes'
>;

/** A draft counts whatever its stored mode: publishing converts it, so what it
 *  runs under is the new rules. A published row with no mode reads as old, the
 *  backend's default. */
export const usesOneWinnerView = (e: DrawMode): boolean =>
  e.status === 'draft' || e.draw_mode === 'one_winner';

/** A draft from before one-winner events: the operator has to be told. */
export const convertsOnPublish = (e: DrawMode): boolean =>
  e.status === 'draft' && e.draw_mode !== 'one_winner';

/** Past the draft stage a one-winner event has tickets, entrants and a seed
 *  hash of its own. An old event keeps those per prize, and a draft has none. */
export const showsEventTotals = (e: DrawMode): boolean =>
  e.draw_mode === 'one_winner' && e.status !== 'draft';

/** The draw's outcome. A one-winner draw writes one result row per prize with
 *  the same winner and seed, no-entries draws included, so any of them will do
 *  and "a result exists" needs no field of its own. */
export const eventResult = (
  e: Pick<AdminLuckyDrawEvent, 'prizes'>,
): AdminLuckyDrawPrize['result'] =>
  e.prizes.find((p) => p.result)?.result ?? null;

export type EventPhase =
  | 'draft'
  | 'upcoming'
  | 'running'
  | 'drawing'
  | 'overdue'
  | 'drawn'
  | 'withdrawn';

export const eventPhase = (e: EventClock, now: number = Date.now()): EventPhase => {
  if (e.status === 'cancelled') return 'withdrawn';
  if (e.status === 'draft') return 'draft';
  if (eventResult(e)) return 'drawn';
  if (now < Date.parse(e.starts_at)) return 'upcoming';
  if (now < Date.parse(e.ends_at)) return 'running';
  return now <= Date.parse(e.ends_at) + OVERDUE_AFTER_MS ? 'drawing' : 'overdue';
};

/** Why an event's prizes can't change, or null while they can. A draft never
 *  started, whatever the clock says: customers can't see it. */
export const prizeLock = (e: EventClock, now: number = Date.now()): string | null => {
  switch (eventPhase(e, now)) {
    case 'draft':
    case 'upcoming':
      return null;
    case 'drawn':
      return 'This event has been drawn, so its prizes are final. Only its name can change.';
    case 'withdrawn':
      return 'This event was withdrawn, so it is closed.';
    default:
      return 'The event has started, so its prizes are locked. Only its name can change.';
  }
};

/** A published event keeps at least one prize; to stop it, withdraw it. */
export const canRemovePrize = (e: EventClock, now: number = Date.now()): boolean =>
  prizeLock(e, now) === null &&
  (e.status !== 'published' || e.prizes.filter((p) => !p.cancelled_at).length > 1);

export const canWithdraw = (
  e: Pick<AdminLuckyDrawEvent, 'status' | 'draw_mode' | 'prizes'>,
): boolean =>
  e.draw_mode === 'one_winner' && e.status === 'published' && !eventResult(e);

/** A prize's own state on the one-winner screen. Overdue is the event's to say:
 *  a prize has no draw of its own, and an old draft's can carry an early time
 *  until publishing moves it. */
export const potPrizeState = (
  p: Pick<AdminLuckyDrawPrize, 'cancelled_at' | 'result' | 'draw_at'>,
  now: number = Date.now(),
): Exclude<PrizeState, 'overdue'> => {
  const state = prizeState(p, now);
  return state === 'overdue' ? 'open' : state;
};

/** What is wrong with a typed window, or null. Blank is not called out: the
 *  form just can't be sent yet. The end is the draw time, so it has the draw
 *  time's lead; a start already passed is fine, the event goes live on publish. */
export const windowProblem = (
  d: Pick<EventDraft, 'startsAt' | 'endsAt'>,
  now: number = Date.now(),
): string | null => {
  const starts = toIso(d.startsAt);
  const ends = toIso(d.endsAt);
  if (starts === null || ends === null) return null;
  const end = Date.parse(ends);
  if (end <= Date.parse(starts)) return 'The end must be after the start.';
  return end <= now + LUCKY_DRAW_MIN_LEAD_MS
    ? 'The end must be at least 2 minutes from now.'
    : null;
};

/** A refused publish, for the toast. The route answers an overlap with a 409
 *  naming the clashing event. Should that ever reach Medusa's error handler
 *  instead, its generic CONFLICT text would say nothing useful. */
export const publishErrorText = (err: Error): string =>
  err.message.includes('Idempotency-Key')
    ? 'This event overlaps another published event. Move its window first.'
    : err.message;

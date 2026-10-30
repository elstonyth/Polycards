// The Lucky Draw console's pure half: the shapes the event and prize forms
// edit, how a saved row becomes one, and how it becomes a payload again. Split
// out of page.tsx for the reason task-draft.ts is — the round trip is where a
// form silently drops a field, and the admin vitest runner has no DOM.
import type {
  AdminLuckyDrawEvent,
  AdminLuckyDrawEventInput,
  AdminLuckyDrawPrize,
  AdminLuckyDrawPrizeInput,
} from '../../lib/admin-rest';
import { toIso, toLocalInput } from '../tasks/task-draft';

// Mirror the backend's saveLuckyDrawEvent / saveLuckyDrawPrize (the gate that
// matters) so a bad form is refused before the round trip.
const MAX_EVENT_NAME = 80;
export const MAX_PRIZE_TITLE = 120;
const MAX_PRIZE_CREDIT_MYR = 50_000;
/** The backend's lead on a draw time. */
export const LUCKY_DRAW_MIN_LEAD_MS = 2 * 60 * 1000;

/** A credit amount as typed, or null if the backend would refuse it: not a
 *  number, not above 0, over the ceiling, or not whole sen. */
export function parseCreditAmount(text: string): number | null {
  const amount = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PRIZE_CREDIT_MYR)
    return null;
  // Whole sen: the same test the backend runs (fromSen(toSen(x)) === x).
  return Math.round(amount * 100) / 100 === amount ? amount : null;
}

export interface PrizeDraft {
  id?: string;
  kind: 'card' | 'credit';
  cardHandle: string;
  creditMyr: string;
  title: string;
  imageUrl: string;
  sort: string;
  /** datetime-local, browser wall clock. Blank = the event's end on a new
   *  prize, the stored time on an edit. */
  drawAt: string;
}

export const blankPrizeDraft = (): PrizeDraft => ({
  kind: 'card',
  cardHandle: '',
  creditMyr: '',
  title: '',
  imageUrl: '',
  sort: '0',
  drawAt: '',
});

export function prizeDraftFrom(p: AdminLuckyDrawPrize): PrizeDraft {
  return {
    id: p.id,
    kind: p.kind,
    cardHandle: p.card_handle ?? '',
    creditMyr: p.credit_myr == null ? '' : String(p.credit_myr),
    title: p.title,
    imageUrl: p.image_url ?? '',
    sort: String(p.sort),
    drawAt: toLocalInput(new Date(p.draw_at)),
  };
}

/** null when the backend would refuse it: no card / credit / title, a credit
 *  that is not whole sen, a credit prize without art, or a half-typed time.
 *  Every field is sent — the prize save resets an omitted sort to 0 and an
 *  omitted image to null, so an edit that left them out would wipe them. */
export function prizeDraftToPayload(
  d: PrizeDraft,
  eventId: string,
): AdminLuckyDrawPrizeInput | null {
  const title = d.title.trim();
  if (!title || title.length > MAX_PRIZE_TITLE) return null;

  const sort = d.sort.trim() === '' ? 0 : Number(d.sort);
  if (!Number.isInteger(sort)) return null;

  const drawAt = toIso(d.drawAt);
  if (d.drawAt !== '' && drawAt === null) return null;

  const imageUrl = d.imageUrl.trim() || null;
  let cardHandle: string | null = null;
  let creditMyr: number | null = null;
  if (d.kind === 'card') {
    cardHandle = d.cardHandle.trim() || null;
    if (!cardHandle) return null;
  } else {
    creditMyr = parseCreditAmount(d.creditMyr);
    if (creditMyr === null) return null;
  }

  return {
    ...(d.id ? { id: d.id } : {}),
    event_id: eventId,
    kind: d.kind,
    card_handle: cardHandle,
    credit_myr: creditMyr,
    title,
    image_url: imageUrl,
    sort,
    draw_at: drawAt,
  };
}

/** A typed draw time outside the event window, or null if it is fine (blank
 *  is fine — the backend fills it). Same bounds as the backend: after the
 *  start, by the end. */
export function drawTimeProblem(
  d: Pick<PrizeDraft, 'drawAt'>,
  event: Pick<AdminLuckyDrawEvent, 'starts_at' | 'ends_at'>,
): string | null {
  const iso = toIso(d.drawAt);
  if (iso === null) return null;
  const at = new Date(iso).getTime();
  return at > new Date(event.starts_at).getTime() &&
    at <= new Date(event.ends_at).getTime()
    ? null
    : 'The draw time must fall after the event starts and by the time it ends.';
}

export interface EventDraft {
  id?: string;
  name: string;
  /** datetime-local strings, browser wall clock. */
  startsAt: string;
  endsAt: string;
}

export const blankEventDraft = (): EventDraft => ({
  name: '',
  startsAt: '',
  endsAt: '',
});

export const eventDraftFrom = (e: AdminLuckyDrawEvent): EventDraft => ({
  id: e.id,
  name: e.name,
  startsAt: toLocalInput(new Date(e.starts_at)),
  endsAt: toLocalInput(new Date(e.ends_at)),
});

/** null when the backend would refuse it. A blank or half-typed time is
 *  refused — an event with no window is not a thing. */
export function eventDraftToPayload(
  d: EventDraft,
): AdminLuckyDrawEventInput | null {
  const name = d.name.trim();
  if (!name || name.length > MAX_EVENT_NAME) return null;
  const startsAt = toIso(d.startsAt);
  const endsAt = toIso(d.endsAt);
  if (startsAt === null || endsAt === null) return null;
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return null;
  return {
    ...(d.id ? { id: d.id } : {}),
    name,
    starts_at: startsAt,
    ends_at: endsAt,
  };
}

export type PrizeState =
  | 'cancelled'
  | 'drawn'
  | 'ungranted'
  | 'overdue'
  | 'open';

/** The draw job ticks every minute; past this, a missing result is a problem. */
export const OVERDUE_AFTER_MS = 2 * 60 * 1000;

/** Cancelled beats drawn: a cancelled prize never has a result (the backend
 *  refuses to cancel a drawn one), but if both ever showed, the refund is the
 *  fact customers care about. `ungranted` is a drawn prize whose winner got
 *  nothing (spec §8: never drawn-but-unpaid); `overdue` an undrawn one whose
 *  draw keeps failing. Both need staff. */
export const prizeState = (
  p: Pick<AdminLuckyDrawPrize, 'cancelled_at' | 'result' | 'draw_at'>,
  now: number = Date.now(),
): PrizeState => {
  if (p.cancelled_at) return 'cancelled';
  if (p.result) return p.result.granted === false ? 'ungranted' : 'drawn';
  return new Date(p.draw_at).getTime() < now - OVERDUE_AFTER_MS
    ? 'overdue'
    : 'open';
};

/** The head of a seed commitment, for a table cell. */
export const shortHash = (hash: string | null): string =>
  hash === null ? '—' : hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;

/** An ISO instant as the browser's wall clock — the same clock the
 *  datetime-local inputs use, so a table cell and the form agree. */
export const whenLabel = (iso: string): string => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
};

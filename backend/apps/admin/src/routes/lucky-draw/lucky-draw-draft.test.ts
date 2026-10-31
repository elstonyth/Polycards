import { describe, expect, test } from 'vitest';
import {
  blankEventDraft,
  blankPrizeDraft,
  drawTimeProblem,
  eventDraftFrom,
  eventDraftToPayload,
  prizeDraftFrom,
  prizeDraftToPayload,
  prizeState,
  shortHash,
  whenLabel,
  type PrizeDraft,
} from './lucky-draw-draft';
import type {
  AdminLuckyDrawEvent,
  AdminLuckyDrawPrize,
} from '../../lib/admin-rest';
import { toIso, toLocalInput } from '../tasks/task-draft';

const DRAW_AT = '2026-11-30T12:00:00.000Z';

const prize = (
  over: Partial<AdminLuckyDrawPrize> = {},
): AdminLuckyDrawPrize => ({
  id: 'ldprz_1',
  kind: 'card',
  card_handle: 'charizard-psa10',
  credit_myr: null,
  title: 'Charizard PSA 10',
  image_url: null,
  sort: 2,
  draw_at: DRAW_AT,
  cancelled_at: null,
  seed_hash: 'a'.repeat(64),
  total_tickets: 0,
  entrant_count: 0,
  value_myr: 1200,
  result: null,
  ...over,
});

const event = (over: Partial<AdminLuckyDrawEvent> = {}): AdminLuckyDrawEvent => ({
  id: 'ldevt_1',
  name: 'November Lucky Draw',
  starts_at: '2026-11-01T00:00:00.000Z',
  ends_at: '2026-11-30T12:00:00.000Z',
  status: 'draft',
  draw_mode: 'one_winner',
  seed_hash: null,
  total_tickets: 0,
  entrant_count: 0,
  prizes: [],
  ...over,
});

// The round trip is where a form silently drops a field: open a saved prize,
// change nothing, save — the payload must be what came in. The prize save
// resets an omitted sort to 0 and an omitted image to null, so every field
// has to make the trip.
describe('prizeDraftFrom → prizeDraftToPayload', () => {
  test('a card prize round-trips every field', () => {
    const p = prize({ sort: 3, image_url: '/static/charizard.png' });
    expect(prizeDraftToPayload(prizeDraftFrom(p), 'ldevt_1')).toEqual({
      id: 'ldprz_1',
      event_id: 'ldevt_1',
      kind: 'card',
      card_handle: 'charizard-psa10',
      credit_myr: null,
      title: 'Charizard PSA 10',
      image_url: '/static/charizard.png',
      sort: 3,
      draw_at: DRAW_AT,
    });
  });

  test('a credit prize round-trips every field', () => {
    const p = prize({
      id: 'ldprz_2',
      kind: 'credit',
      card_handle: null,
      credit_myr: 250.5,
      title: 'RM 250.50 credit',
      image_url: '/static/credit.png',
      sort: 0,
    });
    expect(prizeDraftToPayload(prizeDraftFrom(p), 'ldevt_1')).toEqual({
      id: 'ldprz_2',
      event_id: 'ldevt_1',
      kind: 'credit',
      card_handle: null,
      credit_myr: 250.5,
      title: 'RM 250.50 credit',
      image_url: '/static/credit.png',
      sort: 0,
      draw_at: DRAW_AT,
    });
  });

  test('a new prize carries no id (that is what makes the backend create it)', () => {
    const d: PrizeDraft = {
      ...blankPrizeDraft(),
      cardHandle: 'pikachu',
      title: 'Pikachu',
    };
    const payload = prizeDraftToPayload(d, 'ldevt_1');
    expect(payload).not.toBeNull();
    expect('id' in payload!).toBe(false);
  });

  test('a blank draw time is sent as null (backend: event end on create, keep on edit)', () => {
    const d: PrizeDraft = {
      ...blankPrizeDraft(),
      cardHandle: 'pikachu',
      title: 'Pikachu',
    };
    expect(prizeDraftToPayload(d, 'ldevt_1')!.draw_at).toBeNull();
  });

  test('the draft shows the draw time as the browser wall clock', () => {
    expect(prizeDraftFrom(prize()).drawAt).toBe(toLocalInput(new Date(DRAW_AT)));
    expect(toIso(prizeDraftFrom(prize()).drawAt)).toBe(DRAW_AT);
  });

  test('a card prize drops a stale credit amount, a credit prize a stale card', () => {
    // Toggling the kind leaves the other kind's text behind in the draft; the
    // backend refuses a prize that carries both.
    const card = prizeDraftToPayload(
      { ...prizeDraftFrom(prize()), creditMyr: '10' },
      'ldevt_1',
    );
    expect(card!.credit_myr).toBeNull();
    const credit = prizeDraftToPayload(
      {
        ...blankPrizeDraft(),
        kind: 'credit',
        cardHandle: 'pikachu',
        creditMyr: '10',
        title: 'RM 10',
        imageUrl: '/static/x.png',
      },
      'ldevt_1',
    );
    expect(credit!.card_handle).toBeNull();
    expect(credit!.credit_myr).toBe(10);
  });
});

describe('prizeDraftToPayload rejects what the backend would reject', () => {
  const credit = (over: Partial<PrizeDraft> = {}): PrizeDraft => ({
    ...blankPrizeDraft(),
    kind: 'credit',
    creditMyr: '25',
    title: 'RM 25 credit',
    imageUrl: '/static/credit.png',
    ...over,
  });
  const card = (over: Partial<PrizeDraft> = {}): PrizeDraft => ({
    ...blankPrizeDraft(),
    cardHandle: 'pikachu',
    title: 'Pikachu',
    ...over,
  });
  const payload = (d: PrizeDraft) => prizeDraftToPayload(d, 'ldevt_1');

  test('a credit amount that is not whole sen', () => {
    expect(payload(credit({ creditMyr: '12.345' }))).toBeNull();
    expect(payload(credit({ creditMyr: '12.34' }))!.credit_myr).toBe(12.34);
    // 0.07 * 100 is 7.000000000000001 in floating point — still whole sen.
    expect(payload(credit({ creditMyr: '0.07' }))!.credit_myr).toBe(0.07);
  });

  test('a credit amount that is blank, zero, negative, over the cap or not a number', () => {
    expect(payload(credit({ creditMyr: '' }))).toBeNull();
    expect(payload(credit({ creditMyr: '0' }))).toBeNull();
    expect(payload(credit({ creditMyr: '-5' }))).toBeNull();
    expect(payload(credit({ creditMyr: 'free' }))).toBeNull();
    expect(payload(credit({ creditMyr: '50000' }))!.credit_myr).toBe(50_000);
    expect(payload(credit({ creditMyr: '50000.01' }))).toBeNull();
  });

  test('a credit prize with no art saves without one (players see coins)', () => {
    expect(payload(credit({ imageUrl: '' }))!.image_url).toBeNull();
    expect(payload(credit({ imageUrl: '   ' }))!.image_url).toBeNull();
  });

  test('a card prize needs no art of its own', () => {
    expect(payload(card({ imageUrl: '' }))!.image_url).toBeNull();
  });

  test('an empty or over-long title', () => {
    expect(payload(card({ title: '' }))).toBeNull();
    expect(payload(card({ title: '   ' }))).toBeNull();
    expect(payload(card({ title: 'x'.repeat(121) }))).toBeNull();
    expect(payload(card({ title: 'x'.repeat(120) }))).not.toBeNull();
  });

  test('a card prize with no card picked', () => {
    expect(payload(card({ cardHandle: '' }))).toBeNull();
    expect(payload(card({ cardHandle: '  ' }))).toBeNull();
  });

  test('a sort that is not a whole number; blank means 0', () => {
    expect(payload(card({ sort: '1.5' }))).toBeNull();
    expect(payload(card({ sort: 'first' }))).toBeNull();
    expect(payload(card({ sort: '' }))!.sort).toBe(0);
    expect(payload(card({ sort: '-2' }))!.sort).toBe(-2);
  });

  test('a half-typed draw time is refused, never treated as blank', () => {
    expect(payload(card({ drawAt: 'not-a-date' }))).toBeNull();
  });
});

describe('drawTimeProblem', () => {
  const ev = event();
  const at = (iso: string) => toLocalInput(new Date(iso));
  const d = (drawAt: string): PrizeDraft => ({ ...blankPrizeDraft(), drawAt });

  test('blank is fine — the backend picks the event end', () => {
    expect(drawTimeProblem(d(''), ev)).toBeNull();
  });

  test('inside the window, end included', () => {
    expect(drawTimeProblem(d(at('2026-11-15T00:00:00.000Z')), ev)).toBeNull();
    expect(drawTimeProblem(d(at(ev.ends_at)), ev)).toBeNull();
  });

  test('at the start, before it, or after the end', () => {
    expect(drawTimeProblem(d(at(ev.starts_at)), ev)).not.toBeNull();
    expect(drawTimeProblem(d(at('2026-10-31T00:00:00.000Z')), ev)).not.toBeNull();
    expect(drawTimeProblem(d(at('2026-12-01T00:00:00.000Z')), ev)).not.toBeNull();
  });
});

describe('event drafts', () => {
  const ready = {
    ...blankEventDraft(),
    name: 'December Lucky Draw',
    startsAt: '2026-12-01T00:00',
    endsAt: '2026-12-31T23:59',
  };

  test('a saved event round-trips, id included', () => {
    const e = event();
    expect(eventDraftToPayload(eventDraftFrom(e))).toEqual({
      id: 'ldevt_1',
      name: 'November Lucky Draw',
      starts_at: e.starts_at,
      ends_at: e.ends_at,
    });
  });

  test('a new event needs no name typed: it is the Prize Pool', () => {
    const payload = eventDraftToPayload({
      ...blankEventDraft(),
      startsAt: ready.startsAt,
      endsAt: ready.endsAt,
    });
    expect(payload?.name).toBe('Prize Pool');
  });

  test('a new event carries no id', () => {
    const payload = eventDraftToPayload(ready);
    expect(payload).not.toBeNull();
    expect('id' in payload!).toBe(false);
  });

  test('a blank name, an over-long name, a blank or reversed window', () => {
    expect(eventDraftToPayload({ ...ready, name: '  ' })).toBeNull();
    expect(eventDraftToPayload({ ...ready, name: 'x'.repeat(81) })).toBeNull();
    expect(eventDraftToPayload({ ...ready, startsAt: '' })).toBeNull();
    expect(eventDraftToPayload({ ...ready, endsAt: '' })).toBeNull();
    expect(
      eventDraftToPayload({ ...ready, endsAt: ready.startsAt }),
    ).toBeNull();
    expect(
      eventDraftToPayload({ ...ready, endsAt: '2026-11-30T00:00' }),
    ).toBeNull();
  });
});

describe('display helpers', () => {
  const BEFORE = Date.parse(DRAW_AT) - 60_000;
  const result = (
    over: Partial<NonNullable<AdminLuckyDrawPrize['result']>> = {},
  ): AdminLuckyDrawPrize['result'] => ({
    winner_customer_id: 'cus_1',
    winner_tickets: 5,
    total_tickets: 50,
    entrant_count: 9,
    drawn_at: DRAW_AT,
    seed: 'b'.repeat(64),
    granted: true,
    ...over,
  });

  test('prizeState: cancelled beats drawn beats open', () => {
    expect(prizeState(prize(), BEFORE)).toBe('open');
    expect(prizeState(prize({ cancelled_at: DRAW_AT }), BEFORE)).toBe(
      'cancelled',
    );
    expect(prizeState(prize({ result: result() }), BEFORE)).toBe('drawn');
  });

  test('prizeState: overdue once the draw is over 2 minutes late with no result', () => {
    const at = Date.parse(DRAW_AT);
    expect(prizeState(prize(), at + 2 * 60_000)).toBe('open');
    expect(prizeState(prize(), at + 2 * 60_000 + 1)).toBe('overdue');
    // A cancelled prize is never overdue; a drawn one is judged by its result.
    expect(
      prizeState(prize({ cancelled_at: DRAW_AT }), at + 3_600_000),
    ).toBe('cancelled');
    expect(prizeState(prize({ result: result() }), at + 3_600_000)).toBe(
      'drawn',
    );
  });

  test('prizeState: ungranted when the winner was not paid; no winner owes nothing', () => {
    expect(
      prizeState(prize({ result: result({ granted: false }) }), BEFORE),
    ).toBe('ungranted');
    expect(
      prizeState(
        prize({ result: result({ winner_customer_id: null, granted: true }) }),
        BEFORE,
      ),
    ).toBe('drawn');
  });

  test('shortHash keeps the head of the commitment and never invents one', () => {
    expect(shortHash('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`);
    expect(shortHash(null)).toBe('—');
    expect(shortHash('abc')).toBe('abc');
  });

  test('whenLabel reads an unparseable instant as a dash, not "Invalid Date"', () => {
    expect(whenLabel('garbage')).toBe('—');
    expect(whenLabel(DRAW_AT)).toBe(new Date(DRAW_AT).toLocaleString());
  });
});

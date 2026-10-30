import { describe, expect, test } from 'vitest';
import {
  canRemovePrize,
  canWithdraw,
  convertsOnPublish,
  eventPhase,
  eventResult,
  potPrizeState,
  prizeLock,
  publishErrorText,
  showsEventTotals,
  usesOneWinnerView,
  windowProblem,
} from './one-winner';
import type {
  AdminLuckyDrawEvent,
  AdminLuckyDrawPrize,
} from '../../lib/admin-rest';
import { toLocalInput } from '../tasks/task-draft';

const STARTS = Date.parse('2026-11-01T00:00:00.000Z');
const ENDS = Date.parse('2026-11-30T12:00:00.000Z');
const BEFORE = STARTS - 60_000;
const DURING = STARTS + 60_000;

type Result = NonNullable<AdminLuckyDrawPrize['result']>;

const result = (over: Partial<Result> = {}): Result => ({
  winner_customer_id: 'cus_1',
  winner_tickets: 5,
  total_tickets: 50,
  entrant_count: 9,
  drawn_at: new Date(ENDS).toISOString(),
  seed: 'b'.repeat(64),
  granted: true,
  ...over,
});

const prize = (
  over: Partial<AdminLuckyDrawPrize> = {},
): AdminLuckyDrawPrize => ({
  id: 'ldprz_1',
  kind: 'card',
  card_handle: 'charizard-psa10',
  credit_myr: null,
  title: 'Charizard PSA 10',
  image_url: null,
  sort: 0,
  draw_at: new Date(ENDS).toISOString(),
  cancelled_at: null,
  seed_hash: null,
  total_tickets: 0,
  entrant_count: 0,
  value_myr: 1200,
  result: null,
  ...over,
});

const event = (over: Partial<AdminLuckyDrawEvent> = {}): AdminLuckyDrawEvent => ({
  id: 'ldevt_1',
  name: 'November Lucky Draw',
  starts_at: new Date(STARTS).toISOString(),
  ends_at: new Date(ENDS).toISOString(),
  status: 'published',
  draw_mode: 'one_winner',
  seed_hash: 'a'.repeat(64),
  total_tickets: 0,
  entrant_count: 0,
  prizes: [prize(), prize({ id: 'ldprz_2' })],
  ...over,
});

describe('which view an event gets', () => {
  test('a one-winner event, whatever its status', () => {
    expect(usesOneWinnerView(event())).toBe(true);
    expect(usesOneWinnerView(event({ status: 'draft' }))).toBe(true);
    expect(usesOneWinnerView(event({ status: 'cancelled' }))).toBe(true);
  });

  test('an old published or cancelled event keeps the old screens', () => {
    expect(usesOneWinnerView(event({ draw_mode: 'per_prize' }))).toBe(false);
    expect(
      usesOneWinnerView(event({ draw_mode: 'per_prize', status: 'cancelled' })),
    ).toBe(false);
  });

  test('a draft shows the new rules even if it is still per_prize: publishing converts it', () => {
    const draft = event({ draw_mode: 'per_prize', status: 'draft' });
    expect(usesOneWinnerView(draft)).toBe(true);
    expect(convertsOnPublish(draft)).toBe(true);
  });

  test('only a draft still on the old rules converts', () => {
    expect(convertsOnPublish(event({ status: 'draft' }))).toBe(false);
    expect(convertsOnPublish(event())).toBe(false);
    expect(convertsOnPublish(event({ draw_mode: 'per_prize' }))).toBe(false);
  });

  test('a published row with no draw_mode reads as old (the backend default)', () => {
    const row = { ...event(), draw_mode: undefined };
    expect(usesOneWinnerView(row as unknown as AdminLuckyDrawEvent)).toBe(false);
  });
});

describe('showsEventTotals', () => {
  test('a one-winner event past the draft stage', () => {
    expect(showsEventTotals(event())).toBe(true);
    expect(showsEventTotals(event({ status: 'cancelled' }))).toBe(true);
  });

  test('not a draft, and not an old event, whose totals are per prize', () => {
    expect(showsEventTotals(event({ status: 'draft' }))).toBe(false);
    expect(showsEventTotals(event({ draw_mode: 'per_prize' }))).toBe(false);
  });
});

describe('eventResult reads the draw from the prize rows it writes', () => {
  test('null until a prize has a result', () => {
    expect(eventResult(event())).toBeNull();
  });

  test('the result of whichever prize has one', () => {
    const r = result();
    expect(
      eventResult(event({ prizes: [prize(), prize({ result: r })] })),
    ).toBe(r);
  });

  test('a no-entries draw still counts as drawn', () => {
    const r = result({ winner_customer_id: null, winner_tickets: 0 });
    expect(eventResult(event({ prizes: [prize({ result: r })] }))).toBe(r);
  });
});

describe('eventPhase', () => {
  test('draft and withdrawn come from the status, whatever the clock says', () => {
    expect(eventPhase(event({ status: 'draft' }), ENDS + 1)).toBe('draft');
    expect(eventPhase(event({ status: 'cancelled' }), DURING)).toBe(
      'withdrawn',
    );
  });

  test('upcoming, then running from the start exactly', () => {
    expect(eventPhase(event(), STARTS - 1)).toBe('upcoming');
    expect(eventPhase(event(), STARTS)).toBe('running');
    expect(eventPhase(event(), ENDS - 1)).toBe('running');
  });

  test('drawing from the end, overdue past 2 minutes with no result', () => {
    expect(eventPhase(event(), ENDS)).toBe('drawing');
    expect(eventPhase(event(), ENDS + 2 * 60_000)).toBe('drawing');
    expect(eventPhase(event(), ENDS + 2 * 60_000 + 1)).toBe('overdue');
  });

  test('a result beats the clock', () => {
    const drawn = event({ prizes: [prize({ result: result() })] });
    expect(eventPhase(drawn, ENDS + 3_600_000)).toBe('drawn');
  });
});

describe('prizeLock: what can change before and after the start', () => {
  test('before the start a published event is open', () => {
    expect(prizeLock(event(), BEFORE)).toBeNull();
    expect(prizeLock(event(), STARTS - 1)).toBeNull();
  });

  test('from the start on it is locked, with a line saying why', () => {
    expect(prizeLock(event(), STARTS)).toMatch(/started/);
    expect(prizeLock(event(), DURING)).toMatch(/started/);
    expect(prizeLock(event(), ENDS + 1)).toMatch(/started/);
    expect(prizeLock(event(), DURING)).toMatch(/only its name/i);
  });

  test('a draft stays open whatever the clock says: it never started', () => {
    expect(prizeLock(event({ status: 'draft' }), DURING)).toBeNull();
    expect(prizeLock(event({ status: 'draft' }), ENDS + 1)).toBeNull();
  });

  test('a drawn or withdrawn event is locked', () => {
    const drawn = event({ prizes: [prize({ result: result() })] });
    expect(prizeLock(drawn, ENDS + 1)).toMatch(/drawn/);
    expect(prizeLock(event({ status: 'cancelled' }), BEFORE)).toMatch(
      /withdrawn/,
    );
  });
});

describe('canRemovePrize', () => {
  test('before the start, while another live prize stays', () => {
    expect(canRemovePrize(event(), BEFORE)).toBe(true);
  });

  test('never the last live prize of a published event', () => {
    expect(canRemovePrize(event({ prizes: [prize()] }), BEFORE)).toBe(false);
    expect(
      canRemovePrize(
        event({
          prizes: [
            prize(),
            prize({ id: 'ldprz_2', cancelled_at: '2026-10-30T00:00:00.000Z' }),
          ],
        }),
        BEFORE,
      ),
    ).toBe(false);
  });

  test('a draft may lose its last prize', () => {
    expect(
      canRemovePrize(event({ status: 'draft', prizes: [prize()] }), BEFORE),
    ).toBe(true);
  });

  test('nothing from the start on', () => {
    expect(canRemovePrize(event(), STARTS)).toBe(false);
  });
});

describe('canWithdraw', () => {
  test('a published one-winner event until a result exists, even past its end', () => {
    expect(canWithdraw(event())).toBe(true);
    expect(
      canWithdraw(event({ prizes: [prize({ result: result() })] })),
    ).toBe(false);
  });

  test('never a draft, a withdrawn event or an old event', () => {
    expect(canWithdraw(event({ status: 'draft' }))).toBe(false);
    expect(canWithdraw(event({ status: 'cancelled' }))).toBe(false);
    expect(canWithdraw(event({ draw_mode: 'per_prize' }))).toBe(false);
  });
});

describe('potPrizeState', () => {
  test('a prize past its draw time is not overdue by itself: the event says so', () => {
    expect(potPrizeState(prize(), ENDS + 3_600_000)).toBe('open');
    // An old draft's prize can carry an early draw time until publish moves it.
    expect(
      potPrizeState(prize({ draw_at: '2026-01-01T00:00:00.000Z' }), BEFORE),
    ).toBe('open');
  });

  test('removed, drawn and unpaid read as they do on the old screen', () => {
    expect(
      potPrizeState(prize({ cancelled_at: '2026-10-30T00:00:00.000Z' }), BEFORE),
    ).toBe('cancelled');
    expect(potPrizeState(prize({ result: result() }), BEFORE)).toBe('drawn');
    expect(
      potPrizeState(prize({ result: result({ granted: false }) }), BEFORE),
    ).toBe('ungranted');
  });
});

describe('windowProblem', () => {
  const at = (ms: number) => toLocalInput(new Date(ms));
  const NOW = Date.parse('2026-10-30T00:00:00.000Z');
  const ok = {
    startsAt: at(NOW + 86_400_000),
    endsAt: at(NOW + 2 * 86_400_000),
  };

  test('a future window is fine', () => {
    expect(windowProblem(ok, NOW)).toBeNull();
  });

  test('blank says nothing yet (the form stays unsendable without a shout)', () => {
    expect(windowProblem({ ...ok, startsAt: '' }, NOW)).toBeNull();
    expect(windowProblem({ ...ok, endsAt: '' }, NOW)).toBeNull();
  });

  test('the end must be after the start', () => {
    expect(windowProblem({ ...ok, endsAt: ok.startsAt }, NOW)).toMatch(
      /after the start/,
    );
    expect(windowProblem({ startsAt: ok.endsAt, endsAt: ok.startsAt }, NOW)).toMatch(
      /after the start/,
    );
  });

  test('the end is the draw time, so it must be at least 2 minutes off', () => {
    expect(
      windowProblem({ startsAt: at(NOW - 60_000), endsAt: at(NOW + 60_000) }, NOW),
    ).toMatch(/2 minutes/);
    expect(
      windowProblem(
        { startsAt: at(NOW - 60_000), endsAt: at(NOW + 5 * 60_000) },
        NOW,
      ),
    ).toBeNull();
  });

  test('a start already passed is allowed: the event goes live when published', () => {
    expect(
      windowProblem({ startsAt: at(NOW - 60_000), endsAt: ok.endsAt }, NOW),
    ).toBeNull();
  });
});

describe('publishErrorText', () => {
  const refusal = (message: string, status: number) =>
    Object.assign(new Error(message), { status });

  test('a 409 from the route shows its own message, clashing event name included', () => {
    expect(
      publishErrorText(
        refusal('This overlaps “December Lucky Draw”.', 409),
      ),
    ).toBe('This overlaps “December Lucky Draw”.');
  });

  test('Medusa’s swapped CONFLICT text becomes a line an operator can read', () => {
    expect(
      publishErrorText(
        refusal(
          'The request conflicted with another request. You may retry the request with the provided Idempotency-Key.',
          409,
        ),
      ),
    ).toMatch(/overlaps another published event/);
  });

  test('any other refusal keeps its message', () => {
    expect(
      publishErrorText(refusal('Add at least one prize before publishing.', 400)),
    ).toBe('Add at least one prize before publishing.');
    expect(publishErrorText(new Error('Failed to fetch'))).toBe(
      'Failed to fetch',
    );
  });
});

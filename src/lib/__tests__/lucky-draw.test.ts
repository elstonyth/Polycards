import { describe, expect, it } from 'vitest';
import {
  chancePercent,
  countdownClock,
  drawCountdown,
  ENTER_REFUSALS,
  ENTER_REFUSAL_COPY,
  entriesIntact,
  entryChance,
  eventResultDetail,
  eventRowId,
  heroFirst,
  heroPrize,
  landingAngle,
  luckyDrawView,
  nextDraw,
  poolDay,
  poolLength,
  poolWhen,
  potTotal,
  refusalCopy,
  rulesCopy,
  segmentAt,
  ticketRanges,
  tilePrice,
  wheelSegments,
  winnerIndex,
} from '@/lib/lucky-draw';

describe('tilePrice', () => {
  it('drops the sen from RM 1,000 up, and keeps small prizes exact', () => {
    expect(tilePrice(175_331.92)).toBe(175_332);
    expect(tilePrice(1000)).toBe(1000);
    expect(tilePrice(999.5)).toBe(999.5);
    expect(tilePrice(10.5)).toBe(10.5);
  });
});

describe('poolLength', () => {
  const start = '2026-11-05T13:00:00.000Z';
  const after = (hours: number) =>
    new Date(Date.parse(start) + hours * 3_600_000).toISOString();

  it('says hours under two days', () => {
    expect(poolLength(start, after(12))).toBe('12-hour');
    expect(poolLength(start, after(24))).toBe('24-hour');
    expect(poolLength(start, after(36))).toBe('36-hour');
  });

  it('says days from two days up', () => {
    expect(poolLength(start, after(48))).toBe('2-day');
    expect(poolLength(start, after(72))).toBe('3-day');
    expect(poolLength(start, after(240))).toBe('10-day');
  });

  it('says weeks for whole weeks', () => {
    expect(poolLength(start, after(168))).toBe('1-week');
    expect(poolLength(start, after(336))).toBe('2-week');
  });

  it('rounds a window that ends a minute short, as admins set them', () => {
    expect(
      poolLength('2026-11-05T16:00:00.000Z', '2026-11-08T15:59:00.000Z'),
    ).toBe('3-day');
    expect(
      poolLength('2026-11-05T16:00:00.000Z', '2026-11-06T15:59:00.000Z'),
    ).toBe('24-hour');
  });

  it('has nothing to say about an unreadable or empty window', () => {
    expect(poolLength('nope', start)).toBeNull();
    expect(poolLength(start, undefined)).toBeNull();
    expect(poolLength(start, start)).toBeNull();
  });
});

describe('poolDay', () => {
  // 11:59 PM on Thu 5 Nov in Malaysia, still the 5th in UTC too.
  const now = Date.parse('2026-11-05T15:59:00.000Z');

  it('names the near days in Malaysia time, not UTC', () => {
    expect(poolDay('2026-11-05T01:00:00.000Z', now)).toBe('Today');
    expect(poolDay('2026-11-05T16:00:00.000Z', now)).toBe('Tomorrow');
    expect(poolDay('2026-11-04T15:59:00.000Z', now)).toBe('Yesterday');
  });

  it('gives the weekday and date further out', () => {
    expect(poolDay('2026-11-08T13:00:00.000Z', now)).toBe('Sun 8 Nov');
    expect(poolDay('2026-11-01T13:00:00.000Z', now)).toBe('Sun 1 Nov');
  });

  it('gives the plain date with no clock yet, so hydration agrees', () => {
    expect(poolDay('2026-11-05T01:00:00.000Z', null)).toBe('Thu 5 Nov');
  });

  it('reads an unreadable date as nothing', () => {
    expect(poolDay('nope', now)).toBe('');
    expect(poolDay('nope', null)).toBe('');
  });
});

describe('poolWhen', () => {
  const now = Date.parse('2026-11-05T15:59:00.000Z');

  it('reads inside a sentence', () => {
    expect(poolWhen('2026-11-05T15:59:30.000Z', now)).toBe(
      'today, 11:59 PM MYT',
    );
    expect(poolWhen('2026-11-06T13:00:00.000Z', now)).toBe(
      'tomorrow, 9:00 PM MYT',
    );
    expect(poolWhen('2026-11-08T13:00:00.000Z', now)).toBe(
      'Sun 8 Nov, 9:00 PM MYT',
    );
  });
});

describe('entryChance', () => {
  const row = { my_tickets: 30, total_tickets: 100 };

  it('states the chance now while the pool is open', () => {
    expect(entryChance({ ...row, status: 'open' })).toBe('30% chance');
  });

  it('states the chance they had once it is drawn', () => {
    expect(entryChance({ ...row, status: 'won' })).toBe('had a 30% chance');
    expect(entryChance({ ...row, status: 'lost' })).toBe('had a 30% chance');
  });

  it('says nothing for a refunded pool, an old prize row or an empty total', () => {
    expect(entryChance({ ...row, status: 'cancelled' })).toBeNull();
    expect(entryChance({ my_tickets: 30, status: 'lost' })).toBeNull();
    expect(
      entryChance({ my_tickets: 30, total_tickets: 0, status: 'open' }),
    ).toBeNull();
  });
});

describe('chancePercent', () => {
  it('reads the share of tickets the way the prize card shows it', () => {
    expect(chancePercent(30, 100)).toBe('30%');
    expect(chancePercent(1, 300)).toBe('0.3%');
    expect(chancePercent(1, 5000)).toBe('<0.1%');
    expect(chancePercent(0, 0)).toBe('0%');
  });

  it('never rounds a near-10% share up to "10.0%"', () => {
    expect(chancePercent(996, 10_000)).toBe('10%');
  });

  it('never promises 100% while someone else holds tickets', () => {
    expect(chancePercent(9_999, 10_000)).toBe('99%');
    expect(chancePercent(50, 50)).toBe('100%');
  });

  it('reads no tickets as 0%', () => {
    expect(chancePercent(0, 400)).toBe('0%');
  });
});

describe('drawCountdown', () => {
  const at = '2026-11-30T15:59:00Z';
  it('counts down in days, hours, then minutes', () => {
    expect(drawCountdown(at, Date.parse('2026-11-28T11:59:00Z'))).toBe('2d 4h');
    expect(drawCountdown(at, Date.parse('2026-11-30T12:54:00Z'))).toBe(
      '3h 05m',
    );
    expect(drawCountdown(at, Date.parse('2026-11-30T15:54:51Z'))).toBe(
      '4m 09s',
    );
    expect(drawCountdown(at, Date.parse('2026-11-30T16:00:00Z'))).toBe(
      'Drawing…',
    );
  });

  it('says Drawing… only once the draw time has come', () => {
    expect(drawCountdown(at, Date.parse(at) - 400)).toBe('0m 01s');
    expect(drawCountdown(at, Date.parse(at))).toBe('Drawing…');
  });
});

describe('countdownClock', () => {
  const at = '2026-11-30T15:59:00Z';
  it('splits the time left into zero-padded days, hours, minutes, seconds', () => {
    expect(countdownClock(at, Date.parse('2026-11-28T11:54:51Z'))).toEqual({
      d: '02',
      h: '04',
      m: '04',
      s: '09',
    });
  });

  it('rounds seconds up and stops at the draw time', () => {
    expect(countdownClock(at, Date.parse(at) - 400)).toEqual({
      d: '00',
      h: '00',
      m: '00',
      s: '01',
    });
    expect(countdownClock(at, Date.parse(at))).toBeNull();
    expect(countdownClock('not a date', 0)).toBeNull();
  });
});

describe('nextDraw', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const prize = (draw_at: string, drawn = false) => ({
    draw_at,
    result: drawn ? {} : null,
  });

  it('is the soonest undrawn prize still ahead', () => {
    expect(
      nextDraw(
        [
          prize('2026-11-30T15:59:00Z'),
          prize('2026-11-01T00:00:00Z', true),
          prize('2026-11-15T12:00:00Z'),
        ],
        now,
      ),
    ).toEqual({ kind: 'next', at: '2026-11-15T12:00:00Z' });
  });

  it('says drawing while a past prize waits for its result', () => {
    expect(nextDraw([prize('2026-11-09T23:59:00Z')], now)).toEqual({
      kind: 'drawing',
    });
  });

  it('is done once every prize is drawn', () => {
    expect(nextDraw([prize('2026-11-01T00:00:00Z', true)], now)).toEqual({
      kind: 'done',
    });
    expect(nextDraw([], now)).toEqual({ kind: 'done' });
  });
});

describe('ENTER_REFUSAL_COPY', () => {
  it('has copy for every refusal the enter route can send', () => {
    for (const reason of ENTER_REFUSALS) {
      expect(ENTER_REFUSAL_COPY[reason]).toMatch(/\S/);
    }
    expect(Object.keys(ENTER_REFUSAL_COPY).sort()).toEqual(
      [...ENTER_REFUSALS].sort(),
    );
  });

  it('says exactly what the brief says', () => {
    expect(ENTER_REFUSAL_COPY).toEqual({
      not_found: 'This prize is no longer available.',
      not_open: 'This Lucky Draw has not started yet.',
      closed: 'Entries for this prize are closed.',
      not_enough_tickets: "You don't have that many tickets.",
      no_topup: 'Top up at least once to enter the Lucky Draw.',
    });
  });
});

describe('ticket ranges and the winner', () => {
  const entries = [{ tickets: 50 }, { tickets: 1 }, { tickets: 49 }];

  it('numbers tickets from 0 through the list in its order', () => {
    expect(ticketRanges(entries)).toEqual([
      { start: 0, end: 49 },
      { start: 50, end: 50 },
      { start: 51, end: 99 },
    ]);
  });

  it('finds the entry holding the winning ticket', () => {
    expect(winnerIndex(entries, 0)).toBe(0);
    expect(winnerIndex(entries, 49)).toBe(0);
    expect(winnerIndex(entries, 50)).toBe(1);
    expect(winnerIndex(entries, 99)).toBe(2);
  });

  it('has no winner without a ticket index or past the last ticket', () => {
    expect(winnerIndex(entries, null)).toBe(-1);
    expect(winnerIndex(entries, 100)).toBe(-1);
    expect(winnerIndex([], 0)).toBe(-1);
  });
});

describe('entriesIntact', () => {
  const entries = [{ tickets: 50 }, { tickets: 1 }, { tickets: 49 }];
  const won = { total_tickets: 100, winner: { who: 'A' } };

  it('accepts a list whose tickets add up to the result', () => {
    expect(entriesIntact(entries, won)).toBe(true);
    expect(entriesIntact([], { total_tickets: 0, winner: null })).toBe(true);
  });

  it('refuses a list missing a row (every later range would shift)', () => {
    expect(entriesIntact([entries[0]!, entries[2]!], won)).toBe(false);
  });

  it('refuses an empty list when the result has a winner', () => {
    expect(entriesIntact([], { total_tickets: 0, winner: { who: 'A' } })).toBe(
      false,
    );
  });
});

describe('wheelSegments', () => {
  it('sizes each segment by its tickets, in list order', () => {
    const segs = wheelSegments([{ tickets: 3 }, { tickets: 1 }], 0);
    expect(segs).toEqual([
      { a0: 0, a1: 270, index: 0 },
      { a0: 270, a1: 360, index: 1 },
    ]);
  });

  it('merges the smallest into one filler arc above the cap, never the winner', () => {
    // Six entrants, cap 4: the winner (smallest of all, keeps its own span)
    // and the two biggest stay; the rest become one filler arc at the end.
    const entries = [
      { tickets: 10 },
      { tickets: 1 }, // winner
      { tickets: 2 },
      { tickets: 30 },
      { tickets: 3 },
      { tickets: 54 },
    ];
    const segs = wheelSegments(entries, 1, 4);
    expect(segs.map((s) => s.index)).toEqual([1, 3, 5, null]);
    const total = 100;
    expect(segs[0]!.a1 - segs[0]!.a0).toBeCloseTo((1 / total) * 360);
    expect(segs[3]!.a1 - segs[3]!.a0).toBeCloseTo(((10 + 2 + 3) / total) * 360);
    expect(segs[segs.length - 1]!.a1).toBeCloseTo(360);
  });

  it('leaves a wheel at or under the cap alone', () => {
    const entries = Array.from({ length: 300 }, () => ({ tickets: 1 }));
    expect(wheelSegments(entries, 7)).toHaveLength(300);
    expect(wheelSegments([...entries, { tickets: 1 }], 7)).toHaveLength(300);
  });
});

describe('landing and the pointer', () => {
  const seg = { a0: 100, a1: 200, index: 0 };

  it('lands inside the middle 56% of the segment', () => {
    expect(landingAngle(seg, 0)).toBeCloseTo(122);
    expect(landingAngle(seg, 1)).toBeCloseTo(178);
  });

  it('reads the segment under the 12 o’clock pointer for a rotation', () => {
    const segs = wheelSegments([{ tickets: 1 }, { tickets: 1 }], 0);
    expect(segmentAt(segs, 0)).toBe(0);
    // Turning the wheel 90° clockwise brings the 270° point under the pointer.
    expect(segmentAt(segs, 90)).toBe(1);
    expect(segmentAt(segs, 360 * 6 + 270)).toBe(0);
    expect(segmentAt(segs, -7)).toBe(0);
  });
});

describe('luckyDrawView', () => {
  const END = '2026-11-30T15:59:00.000Z';
  const endMs = Date.parse(END);
  const pot = (over: { result?: unknown } = {}) => ({
    event: { draw_mode: 'one_winner', ends_at: END, result: null, ...over },
  });

  it('reads a failed page as unavailable', () => {
    expect(luckyDrawView(null, endMs)).toBe('unavailable');
  });

  it('reads no event as coming soon', () => {
    expect(luckyDrawView({ event: null }, endMs)).toBe('coming_soon');
  });

  it('gives a per-prize event, or a card-era one with no mode, the old page', () => {
    expect(
      luckyDrawView(
        { event: { draw_mode: 'per_prize', ends_at: END, result: null } },
        endMs,
      ),
    ).toBe('per_prize');
    expect(luckyDrawView({ event: { ends_at: END } }, endMs)).toBe('per_prize');
    // A running old event never turns into a pot, even past its end.
    expect(luckyDrawView({ event: { ends_at: END } }, endMs + 1)).toBe(
      'per_prize',
    );
  });

  it('keeps a pot open until the very end, then waits for the draw', () => {
    expect(luckyDrawView(pot(), endMs - 1)).toBe('pot_open');
    expect(luckyDrawView(pot(), endMs)).toBe('pot_drawing');
    expect(luckyDrawView(pot(), endMs + 60_000)).toBe('pot_drawing');
  });

  it('shows a stored result whatever the clock says', () => {
    const result = { winner: { who: 'A' } };
    expect(luckyDrawView(pot({ result }), endMs - 1)).toBe('pot_drawn');
    expect(luckyDrawView(pot({ result }), endMs + 1)).toBe('pot_drawn');
    // No entries: still drawn, the panel says nobody entered.
    expect(luckyDrawView(pot({ result: { winner: null } }), endMs + 1)).toBe(
      'pot_drawn',
    );
  });

  it('never asks a clock it does not have yet (server render = hydration)', () => {
    expect(luckyDrawView(pot(), null)).toBe('pot_open');
    expect(luckyDrawView(pot({ result: { winner: null } }), null)).toBe(
      'pot_drawn',
    );
  });
});

describe('chance on the pot', () => {
  it('is 0% with no tickets of mine, or nobody in at all', () => {
    expect(chancePercent(0, 0)).toBe('0%');
    expect(chancePercent(0, 900)).toBe('0%');
  });

  it('rounds to one decimal under 10%, whole numbers above', () => {
    expect(chancePercent(1, 8)).toBe('13%');
    expect(chancePercent(1, 16)).toBe('6.3%');
    expect(chancePercent(1, 1000)).toBe('0.1%');
    expect(chancePercent(1, 1001)).toBe('<0.1%');
  });

  it('is 100% only when every ticket in the pot is mine', () => {
    expect(chancePercent(120, 120)).toBe('100%');
    expect(chancePercent(1999, 2000)).toBe('99%');
  });
});

describe('the pot countdown', () => {
  const END = '2026-11-30T15:59:00.000Z';
  const endMs = Date.parse(END);

  it('holds its last second until the end and stops exactly on it', () => {
    expect(countdownClock(END, endMs - 1)?.s).toBe('01');
    expect(countdownClock(END, endMs)).toBeNull();
    expect(drawCountdown(END, endMs - 1)).toBe('0m 01s');
    expect(drawCountdown(END, endMs)).toBe('Drawing…');
  });

  it('rolls over on the whole day and hour', () => {
    expect(countdownClock(END, endMs - 86_400_000)).toEqual({
      d: '01',
      h: '00',
      m: '00',
      s: '00',
    });
    expect(drawCountdown(END, endMs - 3_600_000)).toBe('1h 00m');
  });
});

describe('potTotal', () => {
  it('adds card and credit prizes', () => {
    const prizes = [
      { kind: 'card', value_myr: 4200 },
      { kind: 'credit', value_myr: 500 },
    ];
    expect(potTotal(prizes)).toBe(4700);
  });

  it('adds in sen, so money never prints a float tail', () => {
    expect(potTotal([{ value_myr: 0.1 }, { value_myr: 0.2 }])).toBe(0.3);
    expect(potTotal([{ value_myr: 1200.55 }, { value_myr: 300.1 }])).toBe(
      1500.65,
    );
  });

  it('is 0 for an empty pot', () => {
    expect(potTotal([])).toBe(0);
  });
});

describe('heroPrize', () => {
  it('is the most valuable card, even beside bigger credit (the card is the hero)', () => {
    const card = { kind: 'card', value_myr: 800 };
    expect(
      heroPrize([
        { kind: 'credit', value_myr: 5000 },
        { kind: 'card', value_myr: 200 },
        card,
      ]),
    ).toBe(card);
  });

  it('falls back to the biggest credit prize, and null on an empty pot', () => {
    const big = { kind: 'credit', value_myr: 500 };
    expect(heroPrize([{ kind: 'credit', value_myr: 50 }, big])).toBe(big);
    expect(heroPrize([])).toBeNull();
  });
});

describe('heroFirst', () => {
  it('leads with the hero and keeps the rest in their order', () => {
    const a = { kind: 'credit', value_myr: 500 };
    const b = { kind: 'card', value_myr: 200 };
    const c = { kind: 'card', value_myr: 800 };
    expect(heroFirst([a, b, c])).toEqual([c, a, b]);
    expect(heroFirst([])).toEqual([]);
  });
});

describe('eventResultDetail', () => {
  const person = { who: 'Mimo', avatar: null, frame: null };
  const raw = {
    result: {
      winner: person,
      winner_tickets: 40,
      total_tickets: 100,
      entrant_count: 2,
      seed: 'c'.repeat(64),
      seed_hash: 'd'.repeat(64),
      drawn_at: '2026-11-30T16:00:00.000Z',
    },
    prizes: [
      { kind: 'credit', title: 'RM 500', image: null, value_myr: 500 },
      { kind: 'card', title: 'Umbreon', image: '/u.webp', value_myr: 4200.5 },
    ],
    entries: [
      { person, tickets: 40 },
      { person: { ...person, who: 'Rin' }, tickets: 60 },
    ],
    ticket_index: 12,
  };

  it('reads as a result the wheel and the sheet already know', () => {
    const d = eventResultDetail('ldev_1', 'November', raw);
    expect(d.result).toMatchObject({
      prize_id: 'ldev_1',
      title: 'November',
      image: '/u.webp', // the hero card, not the first prize
      value_myr: 4700.5, // the whole pot
      winner: person,
      winner_tickets: 40,
      total_tickets: 100,
      seed: raw.result.seed,
      seed_hash: raw.result.seed_hash,
    });
    expect(d.ticket_index).toBe(12);
    expect(d.entries).toBe(raw.entries);
  });

  it('puts the hero first among everything won', () => {
    const d = eventResultDetail('ldev_1', 'November', raw);
    expect(d.prizes?.map((p) => p.title)).toEqual(['Umbreon', 'RM 500']);
  });

  it('holds a no-entries draw: no winner, no ticket', () => {
    const d = eventResultDetail('ldev_1', 'November', {
      ...raw,
      result: { ...raw.result, winner: null, total_tickets: 0 },
      entries: [],
      ticket_index: null,
    });
    expect(d.result.winner).toBeNull();
    expect(d.ticket_index).toBeNull();
  });

  it('holds a detail whose prizes did not read', () => {
    const d = eventResultDetail('ldev_1', 'November', { ...raw, prizes: [] });
    expect(d.result.image).toBeNull();
    expect(d.result.value_myr).toBe(0);
    expect(d.prizes).toEqual([]);
  });
});

describe('eventRowId', () => {
  it('sends a one-winner row to its event', () => {
    expect(eventRowId({ draw_mode: 'one_winner', event_id: 'ldev_1' })).toBe(
      'ldev_1',
    );
  });

  it('leaves old rows on their prize, with or without the new fields', () => {
    expect(eventRowId({})).toBeNull();
    expect(
      eventRowId({ draw_mode: 'per_prize', event_id: 'ldev_1' }),
    ).toBeNull();
    expect(eventRowId({ draw_mode: 'one_winner' })).toBeNull();
  });
});

describe('refusalCopy', () => {
  it('reads as it always did on a prize', () => {
    expect(refusalCopy('closed')).toBe('Entries for this prize are closed.');
    expect(refusalCopy('whatever')).toBe(
      'Could not enter this prize. Please try again later.',
    );
  });

  it('never says "this prize" on a pot', () => {
    for (const reason of [...ENTER_REFUSALS, 'whatever']) {
      expect(refusalCopy(reason, true)).toMatch(/\S/);
      expect(refusalCopy(reason, true)).not.toMatch(/this prize/i);
    }
    expect(refusalCopy('no_topup', true)).toBe(ENTER_REFUSAL_COPY.no_topup);
  });
});

describe('rulesCopy', () => {
  it('says one winner takes every prize on a one-winner event', () => {
    expect(rulesCopy('one_winner')).toMatch(/one winner takes every prize/i);
  });

  it('keeps the old rule on a per-prize event', () => {
    expect(rulesCopy('per_prize')).not.toMatch(/one winner/i);
    expect(rulesCopy('per_prize')).toMatch(/Every winner is drawn/);
  });

  it('names where tickets come from, and nothing says they can’t be bought', () => {
    for (const mode of ['one_winner', 'per_prize'] as const) {
      expect(rulesCopy(mode)).toContain(
        'Tickets come from tasks, capsules and Polycards gifts.',
      );
      expect(rulesCopy(mode)).not.toMatch(/bought/);
    }
  });
});

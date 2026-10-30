import { describe, expect, it } from 'vitest';
import {
  mapOddsToRows,
  previewSets,
  rowsToSetEntries,
  type EditRow,
} from '../../lib/odds-rows';
import type { AdminTicketPrize } from '../../lib/admin-rest';
import type { OddsRow } from '../../lib/packs-api';
import {
  MAX_TICKET_AMOUNT,
  blankTicketRow,
  isTicketPack,
  mapTicketPrizesToRows,
  parseTicketAmount,
  ticketAmountProblems,
  ticketRowsToPayload,
  ticketSaveBlocked,
} from './ticket-prizes';

const prize = (over: Partial<AdminTicketPrize> = {}): AdminTicketPrize => ({
  tickets: 100,
  rarity: 'Common',
  weight: 1_000_000,
  weight_2: null,
  weight_3: null,
  locked: false,
  ...over,
});

/** A row as the editor holds it, with the rate typed by hand. */
const row = (name: string, over: Partial<EditRow> = {}): EditRow => ({
  ...blankTicketRow(),
  name,
  ...over,
});

describe('parseTicketAmount', () => {
  it.each([
    ['1', 1],
    ['10', 10],
    [' 100 ', 100],
    ['0100', 100],
    [String(MAX_TICKET_AMOUNT), MAX_TICKET_AMOUNT],
  ])('reads %j as %d', (input, amount) => {
    expect(parseTicketAmount(input)).toBe(amount);
  });

  it.each([
    '',
    '   ',
    '0',
    '00',
    '-1',
    '+5',
    '1.5',
    '1.0',
    '1e3',
    '10 000',
    'abc',
    String(MAX_TICKET_AMOUNT + 1),
    '99999999999999999999',
  ])('refuses %j', (input) => {
    expect(parseTicketAmount(input)).toBeNull();
  });
});

describe('ticketAmountProblems', () => {
  it('passes distinct whole amounts', () => {
    expect(ticketAmountProblems([row('5'), row('10'), row('1000')]).size).toBe(
      0,
    );
  });

  it('marks every row of a duplicate, comparing the number and not the text', () => {
    const a = row('100');
    const b = row('0100');
    const c = row('50');
    const problems = ticketAmountProblems([a, b, c]);
    expect(problems.get(a.card_id)).toBe('duplicate');
    expect(problems.get(b.card_id)).toBe('duplicate');
    expect(problems.has(c.card_id)).toBe(false);
  });

  it.each(['0', '1.5', '-5', ''])('marks %j as invalid', (input) => {
    const r = row(input);
    expect(ticketAmountProblems([r]).get(r.card_id)).toBe('invalid');
  });

  it('calls two blank rows invalid, not duplicates', () => {
    const a = row('');
    const b = row('');
    const problems = ticketAmountProblems([a, b]);
    expect(problems.get(a.card_id)).toBe('invalid');
    expect(problems.get(b.card_id)).toBe('invalid');
  });
});

describe('blankTicketRow', () => {
  it('starts as an unlocked Common, the way a newly admitted card does', () => {
    expect(blankTicketRow()).toMatchObject({
      name: '',
      rarity: 'Common',
      locked: false,
      currentPct: 0,
      pctInput: '0',
      pctInput2: '',
      pctInput3: '',
    });
  });

  it('never reuses a row key', () => {
    expect(blankTicketRow().card_id).not.toBe(blankTicketRow().card_id);
  });
});

describe('mapTicketPrizesToRows', () => {
  it('lists the amounts smallest first, whatever order the server sent', () => {
    const rows = mapTicketPrizesToRows([
      prize({ tickets: 1000 }),
      prize({ tickets: 5 }),
      prize({ tickets: 100 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['5', '100', '1000']);
  });

  it('reads weights as win %, keeping inherited apart from a real 0%', () => {
    const [r] = mapTicketPrizesToRows([
      prize({ weight: 125_000, weight_2: 0, weight_3: null, locked: true }),
    ]);
    expect(r.currentPct).toBe(12.5);
    expect(r.pctInput).toBe('12.5');
    expect(r.pctInput2).toBe('0');
    expect(r.pctInput3).toBe('');
    expect(r.locked).toBe(true);
  });

  it('keys a row on its saved amount, not the text being typed', () => {
    const [r] = mapTicketPrizesToRows([prize({ tickets: 100 })]);
    expect(r.card_id).toBe('tickets-100');
    expect({ ...r, name: '200' }.card_id).toBe('tickets-100');
  });
});

describe('ticketRowsToPayload', () => {
  it('sends the amount as a number and rates in odds-route units', () => {
    expect(
      ticketRowsToPayload([
        row(' 100 ', {
          rarity: 'Rare',
          locked: true,
          pctInput: '12.5',
          pctInput2: '',
          pctInput3: '0',
        }),
      ]),
    ).toEqual([
      {
        tickets: 100,
        rarity: 'Rare',
        locked: true,
        pct: 12.5,
        pct_2: null,
        pct_3: 0,
      },
    ]);
  });

  it('round-trips a saved row unchanged', () => {
    const saved = prize({ tickets: 50, rarity: 'Rare', weight: 75_000 });
    expect(ticketRowsToPayload(mapTicketPrizesToRows([saved]))).toEqual([
      {
        tickets: 50,
        rarity: 'Rare',
        locked: false,
        pct: 7.5,
        pct_2: null,
        pct_3: null,
      },
    ]);
  });
});

describe('ticketSaveBlocked', () => {
  const blocked = (rows: EditRow[]) =>
    ticketSaveBlocked(rows, previewSets(rows).error);

  it('allows a table the Common balancer closes to 100', () => {
    expect(
      blocked([
        row('1000', { rarity: 'Rare', locked: true, pctInput: '10' }),
        row('10'),
      ]),
    ).toBe(false);
  });

  it('allows every row locked when they total exactly 100', () => {
    expect(
      blocked([
        row('10', { rarity: 'Rare', locked: true, pctInput: '60' }),
        row('50', { rarity: 'Rare', locked: true, pctInput: '40' }),
      ]),
    ).toBe(false);
  });

  it('blocks every row locked when they total under 100', () => {
    const rows = [
      row('10', { rarity: 'Rare', locked: true, pctInput: '60' }),
      row('50', { rarity: 'Rare', locked: true, pctInput: '30' }),
    ];
    expect(previewSets(rows).error).toMatch(/total exactly 100/);
    expect(blocked(rows)).toBe(true);
  });

  it('blocks a table over 100 even with a balancer to absorb it', () => {
    const rows = [
      row('10', { rarity: 'Rare', locked: true, pctInput: '70' }),
      row('50', { rarity: 'Rare', locked: true, pctInput: '40' }),
      row('100'),
    ];
    expect(previewSets(rows).error).toMatch(/over the 100% budget/);
    expect(blocked(rows)).toBe(true);
  });

  it('blocks an alternate set that does not close, naming the set', () => {
    const rows = [
      row('10', {
        rarity: 'Rare',
        locked: true,
        pctInput: '60',
        pctInput2: '50',
      }),
      row('50', { rarity: 'Rare', locked: true, pctInput: '40' }),
    ];
    expect(previewSets(rows).error).toMatch(/^Set 2:/);
    expect(blocked(rows)).toBe(true);
  });

  it('blocks a duplicate amount even when the rates are fine', () => {
    const rows = [
      row('100', { rarity: 'Rare', locked: true, pctInput: '10' }),
      row('100'),
    ];
    expect(previewSets(rows).error).toBeNull();
    expect(blocked(rows)).toBe(true);
  });

  it.each(['0', '1.5'])('blocks amount %j with fine rates', (input) => {
    const rows = [row(input)];
    expect(previewSets(rows).error).toBeNull();
    expect(blocked(rows)).toBe(true);
  });

  it('blocks an empty table', () => {
    expect(blocked([])).toBe(true);
  });
});

// The ticket editor shares the card editor's maths and the card editor's own
// row path stays as it was.
describe('a card pack', () => {
  const card = (over: Partial<OddsRow>): OddsRow => ({
    card_id: 'card',
    name: 'Card',
    image: 'c.png',
    slab_image: null,
    rarity: 'Common',
    market_value: 100,
    stock: 1,
    weight: 0,
    weight_2: null,
    weight_3: null,
    locked: false,
    pct: 0,
    pct_2: 0,
    pct_3: 0,
    top_hit_order: null,
    ...over,
  });

  it.each([undefined, 'cards'] as const)(
    'with prize_type %j opens the card editor',
    (prize_type) => {
      expect(isTicketPack({ prize_type })).toBe(false);
    },
  );

  it('only prize_type tickets opens the ticket editor', () => {
    expect(isTicketPack({ prize_type: 'tickets' })).toBe(true);
  });

  it('keeps the entry shape its odds route reads', () => {
    expect(
      rowsToSetEntries(
        mapOddsToRows([card({ card_id: 'a', rarity: 'Rare', pct: 12.5 })]),
      ),
    ).toEqual([
      {
        card_id: 'a',
        locked: false,
        pct: 12.5,
        rarity: 'Rare',
        pct_2: null,
        pct_3: null,
      },
    ]);
  });

  it('balances the same table to the same rates as a ticket pack', () => {
    const rates = [
      { tickets: 5, rarity: 'Common', weight: 0, locked: false },
      { tickets: 10, rarity: 'Common', weight: 0, locked: false },
      { tickets: 100, rarity: 'Rare', weight: 333_300, locked: true },
    ];
    const cards = mapOddsToRows(
      rates.map((r) =>
        card({
          card_id: `tickets-${r.tickets}`,
          rarity: r.rarity,
          locked: r.locked,
          pct: r.weight / 10_000,
        }),
      ),
    );
    const tickets = mapTicketPrizesToRows(rates.map((r) => prize(r)));
    const fromTickets = previewSets(tickets);
    expect(fromTickets.error).toBeNull();
    expect(fromTickets.pct).toEqual(previewSets(cards).pct);
    expect(fromTickets.pct[1].get('tickets-100')).toBe(33.33);
  });
});

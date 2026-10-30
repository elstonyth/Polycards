import { TOTAL_UNITS } from '@acme/odds-math';
import { drawTickets, rollTicketSpins, ticketOddsRows } from '../ticket-spin';
import { fetchPackData } from '../../../workflows/steps/roll-pack';
import type PacksModuleService from '../service';

const rows = [
  { tickets: 10, rarity: 'Common', weight: 900_000, weight_2: 0, weight_3: null },
  { tickets: 100, rarity: 'Rare', weight: 100_000, weight_2: TOTAL_UNITS, weight_3: null },
  { tickets: 1000, rarity: 'Immortal', weight: 0, weight_2: null, weight_3: 500_000 },
];

const packsWith = (
  pack: Record<string, unknown> | null,
  prizes: typeof rows = rows,
) =>
  ({
    listPacks: async () => (pack ? [pack] : []),
    listTicketPrizes: async () => prizes,
  }) as unknown as PacksModuleService;

const LIVE = {
  slug: 'lucky',
  category: 'poly',
  status: 'active',
  prize_type: 'tickets',
  in_stock: true,
  price: '10',
};

describe('drawTickets', () => {
  it('walks the weights of the chosen set', () => {
    expect(drawTickets(rows, 1, 0)).toEqual({ tickets: 10, rarity: 'Common' });
    expect(drawTickets(rows, 1, 899_999).tickets).toBe(10);
    expect(drawTickets(rows, 1, 900_000)).toEqual({
      tickets: 100,
      rarity: 'Rare',
    });
    // Set 2: 10 tickets is 0 there, and 1000's null inherits set 1's 0.
    expect(drawTickets(rows, 2, 0).tickets).toBe(100);
  });

  it('falls back 3 → 2 → 1 per row, as a card pack does', () => {
    // Set 3 resolves to 10: 0 (from set 2), 100: full (from set 2), 1000: half.
    expect(drawTickets(rows, 3, TOTAL_UNITS - 1).tickets).toBe(100);
    expect(drawTickets(rows, 3, TOTAL_UNITS).tickets).toBe(1000);
  });

  it('never picks a zero-weight row with the real random source', () => {
    for (let i = 0; i < 500; i++) {
      expect(drawTickets(rows, 2).tickets).toBe(100);
    }
  });

  it('refuses a table with nothing to win, so nobody is charged for it', () => {
    expect(() => drawTickets([], 1)).toThrow(/no ticket amounts/i);
    expect(() =>
      drawTickets([{ ...rows[0], weight: 0, weight_2: null }], 1),
    ).toThrow(/no ticket amounts/i);
  });
});

describe('rollTicketSpins', () => {
  it('draws count independent rolls and reports the price', async () => {
    const out = await rollTicketSpins(packsWith(LIVE), 'lucky', 1, 3);
    expect(out.unitPrice).toBe(10);
    expect(out.rolls).toHaveLength(3);
    for (const r of out.rolls) expect([10, 100]).toContain(r.tickets);
  });

  it('refuses what a card pack refuses, before anything is drawn', async () => {
    await expect(
      rollTicketSpins(packsWith(null), 'lucky', 1, 1),
    ).rejects.toThrow(/not available/);
    await expect(
      rollTicketSpins(
        packsWith({ ...LIVE, category: 'reward_box' }),
        'lucky',
        1,
        1,
      ),
    ).rejects.toThrow(/not available/);
    await expect(
      rollTicketSpins(packsWith({ ...LIVE, in_stock: false }), 'lucky', 1, 1),
    ).rejects.toThrow(/sold out/);
    await expect(
      rollTicketSpins(packsWith({ ...LIVE, prize_type: 'cards' }), 'lucky', 1, 1),
    ).rejects.toThrow(/not available/);
  });
});

describe('ticketOddsRows', () => {
  it('is the public row, smallest first, with no rate on it', () => {
    const out = ticketOddsRows([rows[2], rows[0]]);
    expect(out).toEqual([
      {
        handle: 'tickets-10',
        tickets: 10,
        name: '10 Tickets',
        rarity: 'Common',
        market_value: 0,
        image: '/images/lucky-draw/ticket.webp',
      },
      {
        handle: 'tickets-1000',
        tickets: 1000,
        name: '1000 Tickets',
        rarity: 'Immortal',
        market_value: 0,
        image: '/images/lucky-draw/ticket.webp',
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/weight/);
  });
});

describe('fetchPackData on a ticket pack', () => {
  it('refuses, so every card path (open, free rips, automation) says why', async () => {
    await expect(
      fetchPackData(packsWith(LIVE), 'lucky'),
    ).rejects.toMatchObject({ type: 'not_allowed' });
  });
});

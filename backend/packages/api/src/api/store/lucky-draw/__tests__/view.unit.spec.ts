import type { MedusaRequest } from '@medusajs/framework/http';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  clearLuckyDrawCache,
  eventDetailFor,
  luckyDrawPageFor,
  resultDetailFor,
} from '../view';

// Every open tab polls results/:prizeId at the draw minute. Until the job has
// drawn, each poll is a miss; the miss is remembered for ~2 s so the stampede
// costs one query per prize per 2 s, not one per poll.
const luckyDrawResult = jest.fn();
const luckyDrawEventResult = jest.fn();
const packs = {
  luckyDrawResult,
  luckyDrawEventResult,
} as unknown as PacksModuleService;
const req = {} as MedusaRequest;

beforeEach(() => {
  clearLuckyDrawCache();
  luckyDrawResult.mockReset().mockResolvedValue(null);
  luckyDrawEventResult.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('remembers an undrawn prize for 2 s, then asks again', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

  expect(await resultDetailFor(req, packs, 'ldpz_1')).toBeNull();
  expect(await resultDetailFor(req, packs, 'ldpz_1')).toBeNull();
  expect(luckyDrawResult).toHaveBeenCalledTimes(1);

  // Another prize is its own miss.
  await resultDetailFor(req, packs, 'ldpz_2');
  expect(luckyDrawResult).toHaveBeenCalledTimes(2);

  now.mockReturnValue(1_000_000 + 2_001);
  expect(await resultDetailFor(req, packs, 'ldpz_1')).toBeNull();
  expect(luckyDrawResult).toHaveBeenCalledTimes(3);
});

it('remembers an undrawn event for 2 s too: every open tab polls it at the end', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

  expect(await eventDetailFor(req, packs, 'ldev_1')).toBeNull();
  expect(await eventDetailFor(req, packs, 'ldev_1')).toBeNull();
  expect(luckyDrawEventResult).toHaveBeenCalledTimes(1);

  now.mockReturnValue(1_000_000 + 2_001);
  expect(await eventDetailFor(req, packs, 'ldev_1')).toBeNull();
  expect(luckyDrawEventResult).toHaveBeenCalledTimes(2);
});

describe('a failed customer read', () => {
  // The drawn event's cache never expires, so it must not keep "Anonymous" for good.
  const listCustomers = jest.fn();
  const drawnReq = {
    scope: { resolve: () => ({ listCustomers }) },
  } as unknown as MedusaRequest;
  const drawn = {
    row: {
      event_id: 'ldev_1',
      winner_customer_id: 'cus_1',
      tier: 'economy',
      prizes: [],
    },
    entries: [{ customer_id: 'cus_1', tickets: 3 }],
    ticket_index: 1,
  };
  const drawnPacks = {
    luckyDrawEventResult: jest.fn().mockResolvedValue(drawn),
    disabledCustomerIds: jest.fn().mockResolvedValue(new Set()),
    siteSettings: jest.fn().mockResolvedValue({ avatar_frames: {} }),
  } as unknown as PacksModuleService;

  it('is read again next time, and a good read is kept', async () => {
    listCustomers.mockReset().mockRejectedValueOnce(new Error('db down'));
    const failed = await eventDetailFor(drawnReq, drawnPacks, 'ldev_1');
    expect(failed?.entries[0]?.person.who).toBe('Anonymous');

    listCustomers.mockResolvedValue([{ id: 'cus_1', first_name: 'Ada' }]);
    const good = await eventDetailFor(drawnReq, drawnPacks, 'ldev_1');
    expect(good?.entries[0]?.person.who).toBe('Ada');

    await eventDetailFor(drawnReq, drawnPacks, 'ldev_1');
    expect(listCustomers).toHaveBeenCalledTimes(2);
  });
});

it('clearLuckyDrawCache forgets the miss', async () => {
  await resultDetailFor(req, packs, 'ldpz_1');
  clearLuckyDrawCache();
  await resultDetailFor(req, packs, 'ldpz_1');
  expect(luckyDrawResult).toHaveBeenCalledTimes(2);
});

// The real seed hash is admin-only (2026-11-24): the public page keeps the
// fields but never the value, while the revealed `seed` still rides on a
// drawn result.
it('hides the real seed hash from the public page', async () => {
  const HASH = 'a'.repeat(64);
  const drawnAt = '2026-11-24T12:00:00.000Z';
  const facts = {
    winner_customer_id: 'cus_1',
    winner_tickets: 3,
    total_tickets: 8,
    entrant_count: 2,
    seed: 's'.repeat(64),
    seed_hash: HASH,
    drawn_at: drawnAt,
  };
  const resultRow = {
    prize_id: 'ldpz_1',
    title: 'RM 25',
    image: null,
    frame: null,
    value_myr: 25,
    drawn_at: drawnAt,
    winner_customer_id: 'cus_1',
    winner_tickets: 3,
    total_tickets: 8,
    entrant_count: 2,
    seed: 's'.repeat(64),
    seed_hash: HASH,
  };
  const hashPacks = {
    luckyDrawPage: jest.fn().mockResolvedValue({
      events: [
        {
          id: 'ldev_1',
          tier: 'economy',
          starts_at: '2026-11-01T00:00:00.000Z',
          ends_at: '2026-11-30T00:00:00.000Z',
          live_at: '2026-11-01T00:00:00.000Z',
          seed_hash: HASH,
          total_tickets: 8,
          entrant_count: 2,
          top: [],
          prizes: [
            {
              kind: 'credit',
              title: 'RM 25',
              image: null,
              frame: null,
              value_myr: 25,
            },
          ],
        },
      ],
      event: {
        id: 'ldev_1',
        name: 'Pot',
        starts_at: '2026-11-01T00:00:00.000Z',
        ends_at: '2026-11-30T00:00:00.000Z',
        draw_mode: 'one_winner',
        seed_hash: HASH,
        total_tickets: 8,
        entrant_count: 2,
        top: [],
        result: facts,
      },
      prizes: [
        {
          id: 'ldpz_1',
          kind: 'credit',
          title: 'RM 25',
          image: null,
          frame: null,
          value_myr: 25,
          draw_at: drawnAt,
          seed_hash: HASH,
          total_tickets: 8,
          entrant_count: 2,
          top: [],
          result: resultRow,
        },
      ],
      next_event: null,
    }),
    luckyDrawBalance: jest.fn().mockResolvedValue(0),
    luckyDrawMyTickets: jest.fn().mockResolvedValue({}),
    luckyDrawMyEventTickets: jest.fn().mockResolvedValue(0),
    luckyDrawMyGateTickets: jest.fn().mockResolvedValue({}),
    disabledCustomerIds: jest.fn().mockResolvedValue(new Set()),
    siteSettings: jest.fn().mockResolvedValue({ avatar_frames: {} }),
  } as unknown as PacksModuleService;
  const hashReq = {
    scope: {
      resolve: () => ({ listCustomers: jest.fn().mockResolvedValue([]) }),
    },
  } as unknown as MedusaRequest;

  const page = await luckyDrawPageFor(hashReq, hashPacks, 'cus_1');

  expect(JSON.stringify(page)).not.toContain(HASH);
  expect(page.event?.seed_hash).toBeNull();
  expect(page.events[0]?.seed_hash).toBeNull();
  expect(page.prizes[0]?.seed_hash).toBe('');
  expect(page.event?.result?.seed_hash).toBe('');
  expect(page.prizes[0]?.result?.seed_hash).toBe('');
  // Seed and hash hidden from storefront (2026-11-24): arena replay uses
  // the recorded ArenaRun, not the seed string.
  expect(page.event?.result?.seed).toBe('');
  expect(page.prizes[0]?.result?.seed).toBe('');
});

import type { MedusaRequest } from '@medusajs/framework/http';
import type PacksModuleService from '../../../../modules/packs/service';
import { clearLuckyDrawCache, eventDetailFor, resultDetailFor } from '../view';

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

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

it('clearLuckyDrawCache forgets the miss', async () => {
  await resultDetailFor(req, packs, 'ldpz_1');
  clearLuckyDrawCache();
  await resultDetailFor(req, packs, 'ldpz_1');
  expect(luckyDrawResult).toHaveBeenCalledTimes(2);
});

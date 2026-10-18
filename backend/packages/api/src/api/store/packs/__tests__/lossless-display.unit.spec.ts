import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { LosslessWindow } from '../../../../modules/packs/lossless';
import {
  clearLosslessDisplayMemo,
  losslessWindowsForDisplay,
} from '../lossless-display';

const T0 = 1_760_000_000_000;
const W: LosslessWindow[] = [
  {
    id: 'lw1',
    starts_at: new Date(T0 - 60_000),
    ends_at: new Date(T0 + 3_600_000),
    cancelled_at: null,
    pack_slugs: null,
  },
];

function fakeReq(read: jest.Mock) {
  const warn = jest.fn();
  const req = {
    scope: {
      resolve: (key: string) =>
        key === ContainerRegistrationKeys.LOGGER
          ? { warn }
          : { losslessWindows: read },
    },
  };
  return { req: req as never, warn };
}

describe('losslessWindowsForDisplay', () => {
  let now = T0;
  beforeEach(() => {
    clearLosslessDisplayMemo();
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('shares one read between concurrent callers and memoizes it for 10s', async () => {
    let resolve!: (w: LosslessWindow[]) => void;
    // First read stays pending until both callers are waiting on it.
    const read = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<LosslessWindow[]>((r) => (resolve = r)),
      )
      .mockResolvedValue(W);
    const { req } = fakeReq(read);

    const a = losslessWindowsForDisplay(req);
    const b = losslessWindowsForDisplay(req);
    resolve(W);
    expect(await a).toBe(W);
    expect(await b).toBe(W);
    expect(read).toHaveBeenCalledTimes(1);

    now = T0 + 9_999;
    await losslessWindowsForDisplay(req);
    expect(read).toHaveBeenCalledTimes(1);

    now = T0 + 10_001;
    await losslessWindowsForDisplay(req);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('on a failed read serves the last good windows for one TTL and warns once', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(W)
      .mockRejectedValue(new Error('pool exhausted'));
    const { req, warn } = fakeReq(read);
    expect(await losslessWindowsForDisplay(req)).toBe(W);

    now = T0 + 10_001;
    expect(await losslessWindowsForDisplay(req)).toBe(W);
    // The failure is memoized: no retry, no second warning inside the TTL.
    now = T0 + 15_000;
    expect(await losslessWindowsForDisplay(req)).toBe(W);
    expect(read).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);

    now = T0 + 20_002;
    await losslessWindowsForDisplay(req);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('serves no windows (the pack rate) when the first read fails', async () => {
    const read = jest.fn().mockRejectedValue(new Error('pool exhausted'));
    const { req, warn } = fakeReq(read);
    expect(await losslessWindowsForDisplay(req)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

import { GET, clearRecentPullsCache } from '../route';

// 2026-10-20 incident: concurrent cache misses each ran the full rebuild,
// draining the DB pool. One rebuild per key must serve every waiter.
describe('GET /store/pulls/recent — rebuild dedupe', () => {
  beforeEach(() => clearRecentPullsCache());

  const makePacks = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const packs = {
      listFxRates: jest.fn(async () => [{ rate: 4.1 }]),
      recentPullRows: jest.fn(async () => {
        await gate;
        return [];
      }),
      pullDrought: jest.fn(async () => 0),
      disabledCustomerIds: jest.fn(async () => new Set<string>()),
      siteSettings: jest.fn(async () => ({ avatar_frames: {} })),
      listCustomerProfiles: jest.fn(async () => []),
      listCards: jest.fn(async () => []),
      listPackOdds: jest.fn(async () => []),
      listPacks: jest.fn(async () => []),
    };
    return { packs, release };
  };

  const call = (packs: unknown) => {
    const res = { json: jest.fn() };
    const req = {
      query: {},
      scope: { resolve: () => packs },
    };
    return {
      res,
      done: GET(req as never, res as never),
    };
  };

  it('runs one rebuild for concurrent misses and answers them all', async () => {
    const { packs, release } = makePacks();
    const calls = Array.from({ length: 5 }, () => call(packs));
    release();
    await Promise.all(calls.map((c) => c.done));
    expect(packs.recentPullRows).toHaveBeenCalledTimes(1);
    for (const c of calls) {
      expect(c.res.json).toHaveBeenCalledWith({
        pulls: [],
        drought: { Immortal: 0, Legendary: 0 },
      });
    }
  });
});

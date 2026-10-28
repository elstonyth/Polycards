import { GET, clearPullGapsCache } from '../route';

// 2026-10-28: the global scan took ~4.4s and every request landing during it
// started its own. One rebuild per key must serve every waiter, and a young
// expired body must be answered at once while the rebuild runs.
describe('GET /store/pulls/gaps — rebuild dedupe', () => {
  beforeEach(() => clearPullGapsCache());

  const makePacks = () => {
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const packs = {
      listPacks: jest.fn(async () => []),
      pullGaps: jest.fn(async () => {
        await gate;
        return { current: 3, avg: 10, last20: 9, hits: [] };
      }),
      disabledCustomerIds: jest.fn(async () => new Set<string>()),
      siteSettings: jest.fn(async () => ({ avatar_frames: {} })),
      listCustomerProfiles: jest.fn(async () => []),
    };
    const reArm = () => {
      gate = new Promise<void>((r) => (release = r));
    };
    return { packs, release: () => release(), reArm };
  };

  const call = (packs: unknown) => {
    const res = { json: jest.fn() };
    const req = {
      query: { rarity: 'Immortal' },
      scope: { resolve: () => packs },
    };
    return { res, done: GET(req as never, res as never) };
  };

  const body = {
    rarity: 'Immortal',
    pct: null,
    expected: null,
    avg: 10,
    last20: 9,
    current: 3,
    hits: [],
  };

  it('runs one scan for concurrent misses and answers them all', async () => {
    const { packs, release } = makePacks();
    const calls = Array.from({ length: 5 }, () => call(packs));
    release();
    await Promise.all(calls.map((c) => c.done));
    expect(packs.pullGaps).toHaveBeenCalledTimes(1);
    for (const c of calls) expect(c.res.json).toHaveBeenCalledWith(body);
  });

  it('serves a young expired body at once while the rebuild runs', async () => {
    const { packs, release, reArm } = makePacks();
    const first = call(packs);
    release();
    await first.done;

    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    reArm();
    const second = call(packs);
    await second.done; // resolves without the gate opening
    expect(second.res.json).toHaveBeenCalledWith(body);
    expect(packs.pullGaps).toHaveBeenCalledTimes(2);
    release();
    spy.mockRestore();
  });
});

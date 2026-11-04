import { POST as quote } from '../quotes/route';
import { POST as accept } from '../[id]/accept/route';
import { GET as history } from '../route';
import { GET as recent, clearRecentCoinFlipsCache } from '../recent/route';
import { GET as settings } from '../settings/route';

const privateRound = {
  id: 'round', customer_id: 'owner', pull_id: 'pull', status: 'lost', stake_cents: 10000,
  expires_at: new Date(), settled_at: new Date(), roll: 900000,
  snapshot: { card: { pull_id: 'pull', name: 'Pikachu', image: '/card.png', grader: 'PSA', grade: '10' },
    actual_win_units: 1000, published_win_units: 500000, group_id: 'secret-group', odds_set: 2 },
};

it('derives owner from authenticated actor and refuses client economics', async () => {
  const service = { quoteCoinFlip: jest.fn().mockResolvedValue({ id: 'round' }), acceptCoinFlip: jest.fn().mockResolvedValue({ id: 'round' }) };
  const req = { auth_context: { actor_id: 'owner' }, scope: { resolve: () => service }, body: { pull_id: 'pull' }, params: { id: 'round' } };
  const res = { json: jest.fn() };
  await quote(req as never, res as never);
  expect(service.quoteCoinFlip).toHaveBeenCalledWith({ customerId: 'owner', pullIds: ['pull'], chosenSide: 'head' });
  await quote({ ...req, body: { pull_ids: ['b', 'a'], chosen_side: 'tail' } } as never, res as never);
  expect(service.quoteCoinFlip).toHaveBeenLastCalledWith({ customerId: 'owner', pullIds: ['a', 'b'], chosenSide: 'tail' });
  for (const body of [{ pull_ids: [], chosen_side: 'head' }, { pull_ids: ['a', 'a'], chosen_side: 'tail' },
    { pull_ids: ['a'] }, { pull_ids: ['a'], chosen_side: 'edge' }, { pull_id: 'a', pull_ids: ['b'] },
    { pull_ids: Array.from({ length: 21 }, (_, i) => `p${i}`), chosen_side: 'head' }]) {
    await expect(quote({ ...req, body } as never, res as never)).rejects.toThrow();
  }
  await expect(quote({ ...req, body: { pull_id: 'pull', amount: 100000, customer_id: 'victim' } } as never, res as never)).rejects.toThrow();
  await accept({ ...req, body: {} } as never, res as never);
  expect(service.acceptCoinFlip).toHaveBeenCalledWith({ customerId: 'owner', roundId: 'round' });
  await expect(accept({ ...req, body: { outcome: 'won' } } as never, res as never)).rejects.toThrow();
  await expect(accept({ ...req, body: { chosen_side: 'tail' } } as never, res as never)).rejects.toThrow();
});

it('takes a ticket stake alone or with cards, and always a stated call', async () => {
  const service = { quoteCoinFlip: jest.fn().mockResolvedValue({ id: 'round' }) };
  const send = (body: unknown) => quote({ auth_context: { actor_id: 'owner' }, scope: { resolve: () => service }, body } as never, { json: jest.fn() } as never);
  await send({ tickets: 5, chosen_side: 'tail' });
  expect(service.quoteCoinFlip).toHaveBeenLastCalledWith({ customerId: 'owner', tickets: 5, chosenSide: 'tail' });
  await send({ tickets: 5, pull_ids: ['pull'], chosen_side: 'head' });
  expect(service.quoteCoinFlip).toHaveBeenLastCalledWith({ customerId: 'owner', pullIds: ['pull'], tickets: 5, chosenSide: 'head' });
  service.quoteCoinFlip.mockClear();
  for (const body of [
    { tickets: 5 },
    { tickets: 5, pull_ids: ['pull'] },
    { tickets: '5', chosen_side: 'head' },
    { tickets: 0, chosen_side: 'head' },
    { tickets: 0, pull_ids: ['pull'], chosen_side: 'head' },
    { tickets: 1.5, chosen_side: 'head' },
    { tickets: 5, pull_id: 'pull', chosen_side: 'head' },
    { tickets: 5, pull_ids: [], chosen_side: 'head' },
    { tickets: 5, chosen_side: 'head', outcome: 'won' },
    { chosen_side: 'head' },
  ]) await expect(send(body)).rejects.toThrow();
  expect(service.quoteCoinFlip).not.toHaveBeenCalled();
});

it('only serializes public history fields and only queries owned terminal rounds', async () => {
  const service = {
    listAndCountCoinFlipRounds: jest.fn().mockResolvedValue([[privateRound], 1]),
    coinFlipLandedCounts: jest.fn().mockResolvedValue({ head: 2, tail: 1 }),
  };
  const res = { json: jest.fn() };
  await history({ auth_context: { actor_id: 'owner' }, scope: { resolve: () => service }, query: {} } as never, res as never);
  expect(service.listAndCountCoinFlipRounds.mock.calls[0][0]).toEqual({ customer_id: 'owner', status: ['won', 'lost'] });
  expect(service.coinFlipLandedCounts).toHaveBeenCalledWith('owner');
  expect(res.json.mock.calls[0][0].rounds[0]).toMatchObject({ status: 'lost', win_amount: 0, published_win_percent: 50 });
  expect(res.json.mock.calls[0][0].totals).toEqual({ head: 2, tail: 1 });
  expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/actual_win|odds_set|group_id|roll|snapshot/);
});

it.each([
  ['won', ['won']],
  ['lost', ['lost']],
  ['quoted', ['won', 'lost']],
  [['won', 'quoted'], ['won', 'lost']],
])('history status %j only ever reads settled rounds', async (status, expected) => {
  const service = {
    listAndCountCoinFlipRounds: jest.fn().mockResolvedValue([[], 0]),
    coinFlipLandedCounts: jest.fn().mockResolvedValue({ head: 0, tail: 0 }),
  };
  await history({ auth_context: { actor_id: 'owner' }, scope: { resolve: () => service }, query: { status } } as never, { json: jest.fn() } as never);
  expect(service.listAndCountCoinFlipRounds.mock.calls[0][0]).toEqual({ customer_id: 'owner', status: expected });
});

it('shows published settings while keeping admin odds out of the storefront', async () => {
  const service = {
    coinFlipSettings: jest.fn().mockResolvedValue({ enabled: true, published_win_percent: 50, win_percent: 35, win_percent_2: 20, revision: 7 }),
    walletSummary: jest.fn().mockResolvedValue({ hasTopup: true, isFrozen: false, playthrough: { remaining: 0 } }),
  };
  const res = { json: jest.fn() };
  await settings({ auth_context: { actor_id: 'owner' }, scope: { resolve: (key: string) => key === 'customer' ? { listCustomerGroups: async () => [] } : service } } as never, res as never);
  expect(res.json).toHaveBeenCalledWith({ enabled: true, published_win_percent: 50, eligible: true, reason: null });
});

describe('everyone feed', () => {
  beforeEach(() => clearRecentCoinFlipsCache());
  const feed = (rounds: unknown[], disabled: string[] = []) => {
    const service = {
      listCoinFlipRounds: jest.fn().mockResolvedValue(rounds),
      disabledCustomerIds: jest.fn().mockResolvedValue(new Set(disabled)),
      siteSettings: jest.fn().mockResolvedValue({ avatar_frames: {} }),
    };
    const customers = { listCustomers: jest.fn().mockResolvedValue([{ id: 'owner', first_name: 'Ash', metadata: {} }]) };
    const res = { json: jest.fn() };
    const run = (query: Record<string, unknown> = {}) => recent({
      auth_context: { actor_id: 'viewer' }, query,
      scope: { resolve: (key: string) => key === 'customer' ? customers : service },
    } as never, res as never);
    return { service, res, run };
  };

  it("lists every player's settled flips with their public name, never ids or odds", async () => {
    const { service, res, run } = feed([privateRound, { ...privateRound, id: 'hidden', customer_id: 'banned' }], ['banned']);
    await run();
    expect(service.listCoinFlipRounds.mock.calls[0][0]).toEqual({ status: ['won', 'lost'] });
    const body = res.json.mock.calls[0][0];
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0]).toMatchObject({ id: 'round', status: 'lost', who: 'Ash', landed_side: 'tail' });
    expect(JSON.stringify(body)).not.toMatch(/customer_id|owner|banned|actual_win|odds_set|group_id|roll|snapshot/);
  });

  it.each([['won', ['won']], ['lost', ['lost']], ['quoted', ['won', 'lost']]])(
    'status %j only ever reads settled rounds', async (status, expected) => {
      const { service, run } = feed([]);
      await run({ status });
      expect(service.listCoinFlipRounds.mock.calls[0][0]).toEqual({ status: expected });
    });

  it('answers polls from one read per window', async () => {
    const { service, res, run } = feed([privateRound]);
    await run();
    await run();
    expect(service.listCoinFlipRounds).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[1][0]).toEqual(res.json.mock.calls[0][0]);
  });
});

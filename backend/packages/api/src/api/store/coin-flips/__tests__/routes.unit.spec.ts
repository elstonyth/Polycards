import { POST as quote } from '../quotes/route';
import { POST as accept } from '../[id]/accept/route';
import { GET as history } from '../route';
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
  expect(service.quoteCoinFlip).toHaveBeenCalledWith({ customerId: 'owner', pullId: 'pull' });
  await expect(quote({ ...req, body: { pull_id: 'pull', amount: 100000, customer_id: 'victim' } } as never, res as never)).rejects.toThrow();
  await accept({ ...req, body: {} } as never, res as never);
  expect(service.acceptCoinFlip).toHaveBeenCalledWith({ customerId: 'owner', roundId: 'round' });
  await expect(accept({ ...req, body: { outcome: 'won' } } as never, res as never)).rejects.toThrow();
});

it('only serializes public history fields and only queries owned terminal rounds', async () => {
  const service = { listAndCountCoinFlipRounds: jest.fn().mockResolvedValue([[privateRound], 1]) };
  const res = { json: jest.fn() };
  await history({ auth_context: { actor_id: 'owner' }, scope: { resolve: () => service }, query: {} } as never, res as never);
  expect(service.listAndCountCoinFlipRounds.mock.calls[0][0]).toEqual({ customer_id: 'owner', status: ['won', 'lost'] });
  expect(res.json.mock.calls[0][0].rounds[0]).toMatchObject({ status: 'lost', win_amount: 0, published_win_percent: 50 });
  expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/actual_win|odds_set|group_id|roll|snapshot/);
});

it('shows published settings while keeping admin odds out of the storefront', async () => {
  const service = {
    coinFlipSettings: jest.fn().mockResolvedValue({ enabled: true, max_stake_amount: 500, published_win_percent: 50, win_percent: 35, win_percent_2: 20, revision: 7 }),
    walletSummary: jest.fn().mockResolvedValue({ hasTopup: true, isFrozen: false, playthrough: { remaining: 0 } }),
  };
  const res = { json: jest.fn() };
  await settings({ auth_context: { actor_id: 'owner' }, scope: { resolve: (key: string) => key === 'customer' ? { listCustomerGroups: async () => [] } : service } } as never, res as never);
  expect(res.json).toHaveBeenCalledWith({ enabled: true, max_stake_amount: 500, published_win_percent: 50, eligible: true, reason: null });
});

// The stock take must run AFTER the claim transaction committed, in the
// route — never inside claimTask. The inventory module writes on its own
// connection and commits at once, so a take inside the claim outlived a claim
// that then lost the unique-index race at flush: a double-tap cost two units
// for one card (review 2026-09).
jest.mock('../../../../../modules/packs/card-stock', () => ({
  takeCardStock: jest.fn(),
}));

import { takeCardStock } from '../../../../../modules/packs/card-stock';
import { POST } from '../claim/route';

const takeCardStockMock = takeCardStock as jest.Mock;

function harness(claimResult: Record<string, unknown>) {
  const take = jest.fn().mockResolvedValue(true);
  takeCardStockMock.mockReturnValue(take);
  const packs = { claimTask: jest.fn().mockResolvedValue(claimResult) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
    params: { id: 'task_1' },
    auth_context: { actor_id: 'cus_1' },
  } as never;
  const res = { json: jest.fn() };
  return { take, packs, logger, req, res: res as never, json: res.json };
}

const cardClaim = {
  claimed: true,
  reward: { type: 'card', card_handle: 'reward-card' },
  ref: 'pull_1',
  claimId: 'tc_1',
};

beforeEach(() => takeCardStockMock.mockReset());

describe('POST /store/tasks/:id/claim — stock take after commit', () => {
  it('takes one unit of the reward card AFTER the claim resolved, then answers', async () => {
    const h = harness(cardClaim);
    await POST(h.req, h.res);
    expect(h.take).toHaveBeenCalledWith('reward-card', 1);
    expect(h.packs.claimTask.mock.invocationCallOrder[0]).toBeLessThan(
      h.take.mock.invocationCallOrder[0],
    );
    expect(h.json).toHaveBeenCalledWith(cardClaim);
  });

  it('the take does NOT ride the claim transaction — no hook is injected', async () => {
    const h = harness(cardClaim);
    await POST(h.req, h.res);
    expect(h.packs.claimTask.mock.calls[0][0]).not.toHaveProperty(
      'decrementStock',
    );
  });

  it('a credit reward takes nothing', async () => {
    const h = harness({
      claimed: true,
      reward: { type: 'credit', amount_myr: 3 },
      ref: 'ct_1',
      claimId: 'tc_1',
    });
    await POST(h.req, h.res);
    expect(h.take).not.toHaveBeenCalled();
  });

  it('a refused claim takes nothing', async () => {
    const h = harness({ claimed: false, reason: 'already_claimed' });
    await POST(h.req, h.res);
    expect(h.take).not.toHaveBeenCalled();
    expect(h.json).toHaveBeenCalledWith({
      claimed: false,
      reason: 'already_claimed',
    });
  });

  it('a failed take is logged, never a customer error — the card is already vaulted', async () => {
    const h = harness(cardClaim);
    h.take.mockRejectedValue(new Error('inventory down'));
    await POST(h.req, h.res);
    expect(h.json).toHaveBeenCalledWith(cardClaim);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('inventory down'),
    );
  });
});

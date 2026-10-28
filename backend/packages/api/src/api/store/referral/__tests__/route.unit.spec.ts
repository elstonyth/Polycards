jest.mock('../../../../workflows/ensure-profile-handle', () => ({
  ensureProfileHandleWorkflow: () => ({
    run: async () => ({ result: { handle: 'MeHandle' } }),
  }),
}));
jest.mock('../friends', () => ({ listReferralFriends: jest.fn() }));

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { GET } from '../route';
import { listReferralFriends } from '../friends';

// GET /store/referral wiring: the friend list is keyed by the verified token
// only (never params/query), and it shares one `now` with the week totals so
// a read across the Tuesday cutover cannot mix two weeks.
const friendsMock = listReferralFriends as jest.Mock;
const assignReferralCode = jest.fn();
const referralStorefrontSummary = jest.fn();
const scope = {
  resolve: () => ({ assignReferralCode, referralStorefrontSummary }),
};

const friend = {
  name: 'AshK',
  handle: 'AshK',
  joined_at: new Date('2026-10-18T10:00:00.000Z'),
  week_spend_cents: 12_345,
};

beforeEach(() => {
  friendsMock.mockReset().mockResolvedValue([friend]);
  assignReferralCode.mockReset().mockResolvedValue('F42B0700');
  referralStorefrontSummary.mockReset().mockResolvedValue({
    downline_count: 1,
    week: {
      start: '2026-10-14',
      turnover_cents: 12_345,
      rate_bp: 50,
      projected_cents: 61,
      partner: false,
    },
    history: [],
  });
});

describe('GET /store/referral', () => {
  it("lists the caller's own friends, ignoring ids in params and query (IDOR)", async () => {
    const out: { body?: unknown } = {};
    const res = { json: (b: unknown) => (out.body = b) };
    const req = {
      auth_context: { actor_id: 'cus_me' },
      params: { customer_id: 'cus_victim' },
      query: { customer_id: 'cus_victim', referrer_id: 'cus_victim' },
      scope,
    };

    await GET(
      req as unknown as AuthenticatedMedusaRequest,
      res as unknown as MedusaResponse,
    );

    expect(friendsMock).toHaveBeenCalledTimes(1);
    const [passedScope, input] = friendsMock.mock.calls[0];
    expect(passedScope).toBe(scope);
    expect(input).toEqual({ customerId: 'cus_me', now: expect.any(Date) });
    // The same instant drives the week totals.
    expect(referralStorefrontSummary).toHaveBeenCalledWith({
      customerId: 'cus_me',
      now: input.now,
    });
    // The player sees what the friend earned them (RM123.45 at 0.5%, rounded
    // down), never the friend's own spend.
    expect(out.body).toEqual(
      expect.objectContaining({
        handle: 'MeHandle',
        code: 'F42B0700',
        downline_count: 1,
        friends: [
          {
            name: 'AshK',
            handle: 'AshK',
            joined_at: friend.joined_at,
            week_earned_cents: 61,
          },
        ],
      }),
    );
    expect(JSON.stringify(out.body)).not.toContain('week_spend_cents');
  });

  it('401s without a verified customer', async () => {
    const req = { auth_context: {}, params: {}, query: {}, scope };

    await expect(
      GET(
        req as unknown as AuthenticatedMedusaRequest,
        {} as unknown as MedusaResponse,
      ),
    ).rejects.toThrow('Unauthorized');
    expect(friendsMock).not.toHaveBeenCalled();
  });
});

import type { MedusaContainer } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { listReferralFriends, REFERRAL_FRIENDS_CAP } from '../friends';

// The friend list is the one place a player reads data about OTHER customers
// on their own referral page, so this pins the privacy contract: only the
// caller's own direct referrals, capped, and public display fields only.
const listReferralAttributions = jest.fn();
const referralDownlineSpend = jest.fn();
const listCustomers = jest.fn();

const scope = {
  resolve: (key: string) =>
    key === PACKS_MODULE
      ? { listReferralAttributions, referralDownlineSpend }
      : key === Modules.CUSTOMER
        ? { listCustomers }
        : undefined,
} as unknown as MedusaContainer;

const now = new Date('2026-10-19T04:00:00.000Z');
const joinedA = new Date('2026-10-18T10:00:00.000Z');
const joinedB = new Date('2026-10-01T10:00:00.000Z');

beforeEach(() => {
  listReferralAttributions.mockReset().mockResolvedValue([
    { customer_id: 'cus_friend_a', referrer_id: 'cus_me', created_at: joinedA },
    { customer_id: 'cus_friend_b', referrer_id: 'cus_me', created_at: joinedB },
  ]);
  referralDownlineSpend.mockReset().mockResolvedValue(
    new Map([
      ['cus_friend_a', { week_cents: 12_345, lifetime_cents: 99_999 }],
      ['cus_friend_b', { week_cents: 0, lifetime_cents: 5_000 }],
    ]),
  );
  listCustomers.mockReset().mockResolvedValue([
    {
      id: 'cus_friend_a',
      first_name: 'AshK',
      last_name: 'Ketchum',
      email: 'ash@example.com',
      phone: '+60123456789',
      metadata: { handle: 'AshK', avatar_url: 'https://x/a.png' },
    },
  ]);
});

describe('listReferralFriends', () => {
  it("reads only the caller's own direct referrals, newest first, capped", async () => {
    await listReferralFriends(scope, { customerId: 'cus_me', now });

    expect(listReferralAttributions).toHaveBeenCalledWith(
      { referrer_id: 'cus_me' },
      { order: { created_at: 'DESC' }, take: REFERRAL_FRIENDS_CAP },
    );
    expect(REFERRAL_FRIENDS_CAP).toBe(100);
    expect(referralDownlineSpend).toHaveBeenCalledWith({
      customerIds: ['cus_friend_a', 'cus_friend_b'],
      now,
    });
    // Names are looked up for exactly those ids, and never select PII columns.
    const [filter, config] = listCustomers.mock.calls[0];
    expect(filter).toEqual({ id: ['cus_friend_a', 'cus_friend_b'] });
    expect(config.select).toEqual(['id', 'first_name', 'metadata']);
  });

  it('returns public display fields and week spend only', async () => {
    const friends = await listReferralFriends(scope, {
      customerId: 'cus_me',
      now,
    });

    expect(friends).toEqual([
      {
        name: 'AshK',
        handle: 'AshK',
        joined_at: joinedA,
        week_spend_cents: 12_345,
      },
      // No customer row (deleted account): anonymous name, no profile link.
      {
        name: expect.stringMatching(/^Collector \d{1,4}$/),
        handle: null,
        joined_at: joinedB,
        week_spend_cents: 0,
      },
    ]);
    const wire = JSON.stringify(friends);
    for (const secret of [
      'cus_friend',
      'ash@example.com',
      '+60123456789',
      'Ketchum',
      '99999',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('skips the lookups when the player has invited nobody', async () => {
    listReferralAttributions.mockResolvedValue([]);

    const friends = await listReferralFriends(scope, {
      customerId: 'cus_me',
      now,
    });

    expect(friends).toEqual([]);
    expect(referralDownlineSpend).not.toHaveBeenCalled();
    expect(listCustomers).not.toHaveBeenCalled();
  });
});

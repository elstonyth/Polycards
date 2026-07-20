import {
  shouldNotifyDeliveryStatus,
  deliveryFeedKey,
  topupFeedKey,
  shouldNotifyTopup,
  rewardWonFeedKey,
  shouldNotifyRewardWon,
} from '../feed-events';

describe('shouldNotifyDeliveryStatus', () => {
  it('notifies on shipped, delivered and canceled', () => {
    expect(shouldNotifyDeliveryStatus('packing', 'shipped')).toBe(true);
    expect(shouldNotifyDeliveryStatus('shipped', 'delivered')).toBe(true);
    expect(shouldNotifyDeliveryStatus('requested', 'canceled')).toBe(true);
  });

  it('does NOT notify on packing — the noisiest operator transition', () => {
    expect(shouldNotifyDeliveryStatus('requested', 'packing')).toBe(false);
  });

  it('does NOT notify on requested — that is the customer own action', () => {
    expect(shouldNotifyDeliveryStatus(null, 'requested')).toBe(false);
  });

  it('does NOT notify when the status did not change', () => {
    // A tracking-only admin update returns the UNCHANGED status from the step,
    // so this guard is what stops a tracking edit from firing a notification.
    expect(shouldNotifyDeliveryStatus('shipped', 'shipped')).toBe(false);
    expect(shouldNotifyDeliveryStatus('delivered', 'delivered')).toBe(false);
  });

  it('does NOT notify on missing or unknown next status', () => {
    expect(shouldNotifyDeliveryStatus('packing', null)).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', undefined)).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', '')).toBe(false);
    expect(shouldNotifyDeliveryStatus('packing', 'teleported')).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('delivery key is one per order per status', () => {
    expect(deliveryFeedKey('do_1', 'shipped')).toBe('delivery:do_1:shipped');
    expect(deliveryFeedKey('do_1', 'delivered')).not.toBe(
      deliveryFeedKey('do_1', 'shipped'),
    );
  });

  it('topup key is one per gateway charge reference', () => {
    expect(topupFeedKey('mock_abc')).toBe('topup:mock_abc');
  });

  it('reward key is one per customer per draw', () => {
    expect(rewardWonFeedKey('cus_1', '2026-07-20', 2)).toBe(
      'reward_won:cus_1:2026-07-20:2',
    );
    expect(rewardWonFeedKey('cus_1', '2026-07-20', 3)).not.toBe(
      rewardWonFeedKey('cus_1', '2026-07-20', 2),
    );
  });
});

describe('shouldNotifyTopup', () => {
  it('notifies a real credit', () => {
    expect(shouldNotifyTopup({ replayed: false, amount: 50 })).toBe(true);
  });

  it('does NOT notify a replay — nothing was credited', () => {
    expect(shouldNotifyTopup({ replayed: true, amount: 50 })).toBe(false);
  });

  it('does NOT notify a zero, negative or missing amount', () => {
    expect(shouldNotifyTopup({ replayed: false, amount: 0 })).toBe(false);
    expect(shouldNotifyTopup({ replayed: false, amount: -5 })).toBe(false);
    expect(shouldNotifyTopup({ replayed: false })).toBe(false);
  });
});

describe('shouldNotifyRewardWon', () => {
  const drawn = {
    status: 'drawn',
    prize: { kind: 'voucher' },
    draw_ordinal: 1,
    draw_day: '2026-07-20',
  };

  it('notifies a real drawn prize', () => {
    expect(shouldNotifyRewardWon(drawn)).toBe(true);
  });

  it('does NOT notify a "nothing" prize — drawn, but nothing to record', () => {
    expect(
      shouldNotifyRewardWon({ ...drawn, prize: { kind: 'nothing' } }),
    ).toBe(false);
  });

  it('does NOT notify unavailable or capped draws — no reward_draw row exists', () => {
    expect(shouldNotifyRewardWon({ ...drawn, status: 'capped' })).toBe(false);
    expect(shouldNotifyRewardWon({ ...drawn, status: 'unavailable' })).toBe(
      false,
    );
  });

  it('does NOT notify when key material is missing', () => {
    expect(shouldNotifyRewardWon({ ...drawn, prize: null })).toBe(false);
    expect(
      shouldNotifyRewardWon({ ...drawn, draw_ordinal: undefined }),
    ).toBe(false);
    expect(shouldNotifyRewardWon({ ...drawn, draw_day: undefined })).toBe(
      false,
    );
  });
});

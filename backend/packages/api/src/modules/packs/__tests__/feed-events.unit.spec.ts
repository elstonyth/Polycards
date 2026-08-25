import {
  shouldNotifyDeliveryStatus,
  deliveryFeedKey,
  topupFeedKey,
  shouldNotifyTopup,
} from '../feed-events';

describe('shouldNotifyDeliveryStatus', () => {
  it('notifies on shipped, completed and canceled', () => {
    expect(shouldNotifyDeliveryStatus('processed', 'shipped')).toBe(true);
    expect(shouldNotifyDeliveryStatus('shipped', 'completed')).toBe(true);
    expect(shouldNotifyDeliveryStatus('requested', 'canceled')).toBe(true);
  });

  it('does NOT notify on processed — an operator back-office step', () => {
    expect(shouldNotifyDeliveryStatus('requested', 'processed')).toBe(false);
  });

  it('does NOT notify on ready_to_ship — an operator back-office step', () => {
    expect(shouldNotifyDeliveryStatus('processed', 'ready_to_ship')).toBe(
      false,
    );
  });

  it('does NOT notify on requested — that is the customer own action', () => {
    expect(shouldNotifyDeliveryStatus(null, 'requested')).toBe(false);
  });

  it('does NOT notify when the status did not change', () => {
    // A tracking-only admin update returns the UNCHANGED status from the step,
    // so this guard is what stops a tracking edit from firing a notification.
    expect(shouldNotifyDeliveryStatus('shipped', 'shipped')).toBe(false);
    expect(shouldNotifyDeliveryStatus('completed', 'completed')).toBe(false);
  });

  it('does NOT notify on missing or unknown next status', () => {
    expect(shouldNotifyDeliveryStatus('processed', null)).toBe(false);
    expect(shouldNotifyDeliveryStatus('processed', undefined)).toBe(false);
    expect(shouldNotifyDeliveryStatus('processed', '')).toBe(false);
    expect(shouldNotifyDeliveryStatus('processed', 'teleported')).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('delivery key is one per order per status', () => {
    expect(deliveryFeedKey('do_1', 'shipped')).toBe('delivery:do_1:shipped');
    expect(deliveryFeedKey('do_1', 'completed')).not.toBe(
      deliveryFeedKey('do_1', 'shipped'),
    );
  });

  it('topup key is one per gateway charge reference', () => {
    expect(topupFeedKey('mock_abc')).toBe('topup:mock_abc');
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


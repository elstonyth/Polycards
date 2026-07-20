// Pure decision + key-building rules for the feed notifications produced by
// routes. No container, no I/O — every branch is unit-testable in isolation,
// which is the whole reason the routes stay thin wiring over this file.

// Which delivery transitions are worth telling a customer about.
//
// 'packing' is deliberately excluded: it is the transition an operator flips
// most casually while working through a queue, so it would be the noisiest and
// least informative of the four. 'requested' is the customer's own action and
// is never news.
const NOTIFIABLE_DELIVERY_STATUSES: readonly string[] = [
  'shipped',
  'delivered',
  'canceled',
];

/**
 * True when a delivery-order status change should produce a feed notification.
 *
 * Both guards are load-bearing:
 *  - the status actually CHANGED. updateDeliveryOrderStep returns the
 *    UNCHANGED status for a tracking-only update, so `next` on its own does
 *    not prove that anything happened.
 *  - the new status is one a customer cares about.
 */
export function shouldNotifyDeliveryStatus(
  prev: string | null | undefined,
  next: string | null | undefined,
): boolean {
  if (!next || next === prev) return false;
  return NOTIFIABLE_DELIVERY_STATUSES.includes(next);
}

/** One notification per order per status — a replayed admin POST dedupes. */
export function deliveryFeedKey(orderId: string, status: string): string {
  return `delivery:${orderId}:${status}`;
}

/** One notification per gateway charge reference. */
export function topupFeedKey(reference: string): string {
  return `topup:${reference}`;
}

/**
 * True when a top-up result represents money that actually arrived.
 *
 * `replayed: true` means the request re-served an already-processed
 * Idempotency-Key — the original row was returned and nothing new was
 * credited, so a second feed row would claim a charge that never happened.
 */
export function shouldNotifyTopup(result: {
  replayed?: boolean;
  amount?: number;
}): boolean {
  return (
    result.replayed !== true &&
    typeof result.amount === 'number' &&
    result.amount > 0
  );
}

/**
 * One notification per customer per draw. Mirrors the anchor drawDailyBox
 * already uses internally for the voucher grant, so the two never disagree
 * about what "the same draw" means.
 */
export function rewardWonFeedKey(
  customerId: string,
  drawDay: string,
  drawOrdinal: number,
): string {
  return `reward_won:${customerId}:${drawDay}:${drawOrdinal}`;
}

/**
 * True when a daily-draw result is worth a feed row.
 *
 * A 'nothing' prize is a normal drawn outcome, but there is no reward to
 * record. 'unavailable' and 'capped' never wrote a reward_draw row at all.
 * The key-material checks keep an incomplete result from producing a
 * malformed idempotency key.
 */
export function shouldNotifyRewardWon(result: {
  status?: string;
  prize?: { kind?: string } | null;
  draw_ordinal?: number;
  draw_day?: string;
}): boolean {
  return (
    result.status === 'drawn' &&
    !!result.prize &&
    result.prize.kind !== 'nothing' &&
    typeof result.draw_ordinal === 'number' &&
    typeof result.draw_day === 'string'
  );
}

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';

export type FeedTemplate =
  | 'commission_matured'
  | 'vip_level_up'
  | 'reward_won'
  | 'voucher_claimed'
  | 'delivery_status'
  | 'topup_credited';

// Thin wrapper over the Notification Module 'feed' channel. receiver_id is the
// owner-scoping column the store route filters on; `to` is the provider's
// required recipient field (local provider). idempotency_key makes redelivery
// exactly-once. data is primitives-only (no HTML, no free-text) — spec §13.
export async function notifyFeed(
  container: { resolve: (k: string) => any },
  args: {
    receiverId: string;
    template: FeedTemplate;
    data: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  const notif = container.resolve(Modules.NOTIFICATION);
  await notif.createNotifications({
    to: args.receiverId,
    receiver_id: args.receiverId,
    channel: 'feed',
    template: args.template,
    data: args.data,
    idempotency_key: args.idempotencyKey,
  });
}

/** Fire a feed notification AFTER the money/state write has committed.
 * Never throws: failure is logged (best-effort) and swallowed — a committed
 * top-up/grant/flip must never fail over a notification. `context` names the
 * producer for the log line, e.g. 'vip-spend-settled'. */
export async function notifyFeedNonfatal(
  container: { resolve: (k: string) => any },
  context: string,
  args: Parameters<typeof notifyFeed>[1],
): Promise<void> {
  try {
    await notifyFeed(container, args);
  } catch (err) {
    try {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `[${context}] notifyFeed('${args.template}') failed for receiver ${args.receiverId} (${args.idempotencyKey}) — state committed, notification dropped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
    } catch {
      // logger not available (unit-test container) — stay silent, never throw.
    }
  }
}

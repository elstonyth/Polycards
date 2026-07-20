import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import { notifyFeed } from '../modules/packs/notify-feed';
import type PacksModuleService from '../modules/packs/service';

// Post-commit subscriber for the vip.spend_settled event (emitted by
// open-pack and open-batch workflows after every settled open). Calls
// grantLevelUpRewards to grant the ladder rewards for every newly-crossed
// VIP level (off the monotonic lifetime counter), upserts vip_member_state,
// and emits a consolidated vip_level_up notification for the customer.
//
// Intentionally thin: all grant logic, idempotency, and monotonic invariants
// live in PacksModuleService.grantLevelUpRewards. This subscriber is a
// forwarder only. Runs in its OWN transaction (post-commit, isolated from
// the settled open) — a grant/notification failure cannot roll back the paid
// open (it already committed). The subscriber must NOT throw on transient
// notification failures (notifyFeed errors are intentionally not re-thrown
// so a missing Notification Module in integration tests does not break the
// grant path — the state upsert and grant rows are the durable record).
export default async function vipSpendSettledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ customer_id: string; open_id: string }>) {
  const packs = container.resolve(PACKS_MODULE) as PacksModuleService;

  const { gained } = await packs.grantLevelUpRewards(
    data.customer_id,
    data.open_id,
  );

  if (gained.length === 0) return;

  try {
    await notifyFeed(container, {
      receiverId: data.customer_id,
      template: 'vip_level_up',
      data: { levels: gained },
      idempotencyKey: `${data.open_id}:levelup`,
    });
  } catch (err) {
    // Notification failure is non-fatal: the grant rows and state upsert are
    // already committed. Resolve AND emit inside one guard so a container
    // without a real logger (e.g. a unit-test container) can't throw out of
    // this path, while operators still get to see provider issues.
    try {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `[vip-spend-settled] notifyFeed('vip_level_up') failed for receiver ${data.customer_id} (open ${data.open_id}) — grants committed, notification dropped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
    } catch {
      // logger not available in test container — silently ignore
    }
  }
}

export const config: SubscriberConfig = {
  event: 'vip.spend_settled',
};

import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { PACKS_MODULE } from '../modules/packs';
import { notifyFeedNonfatal } from '../modules/packs/notify-feed';
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

  // Non-fatal: the grant rows and state upsert are already committed — a
  // notification failure is logged (best-effort) and swallowed, never thrown.
  // Keyed on the rung, not the open — the same key settleVipStep uses, and
  // for the reason given there.
  await notifyFeedNonfatal(container, 'vip-spend-settled', {
    receiverId: data.customer_id,
    template: 'vip_level_up',
    data: { levels: gained },
    idempotencyKey: `vip:${data.customer_id}:L${Math.max(...gained)}`,
  });
}

export const config: SubscriberConfig = {
  event: 'vip.spend_settled',
};

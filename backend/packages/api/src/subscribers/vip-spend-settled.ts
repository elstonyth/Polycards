import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
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
  } catch {
    // Notification failure is non-fatal: the grant rows and state upsert are
    // already committed. Log a warning if a logger is available (it may not be
    // in a unit-test container) so operators can diagnose provider issues.
    resolveLoggerOrNull(container)?.warn(
      `[vip-spend-settled] notification failed for customer ${data.customer_id} open ${data.open_id} — grants committed, notification dropped`,
    );
  }
}

// Resolve the container logger, or null when it is unavailable (e.g. a unit-test
// container). Keeps the non-fatal notification path free of nested try/catch.
function resolveLoggerOrNull(container: {
  resolve: (key: string) => unknown;
}): { warn: (msg: string) => void } | null {
  try {
    return container.resolve('logger') as { warn: (msg: string) => void };
  } catch {
    return null;
  }
}

export const config: SubscriberConfig = {
  event: 'vip.spend_settled',
};

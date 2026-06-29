import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { PACKS_MODULE } from '../modules/packs';
import { notifyFeed } from '../modules/packs/notify-feed';
import type PacksModuleService from '../modules/packs/service';

// Second post-commit consumer of vip.spend_settled (alongside vip-spend-settled).
// Grants any newly-crossed achievements off the fresh metric snapshot. Runs in
// its OWN transaction — a grant/notification failure cannot roll back the paid
// open (already committed). Does NOT touch the credit ledger or commissions.
export default async function achievementsSpendSettledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ customer_id: string; open_id: string }>) {
  const packs = container.resolve(PACKS_MODULE) as PacksModuleService;

  const { newlyUnlocked } = await packs.grantAchievements(
    data.customer_id,
    data.open_id,
  );

  if (newlyUnlocked.length === 0) return;

  try {
    await notifyFeed(container, {
      receiverId: data.customer_id,
      template: 'achievement_unlocked',
      data: { keys: newlyUnlocked },
      idempotencyKey: `${data.open_id}:ach`,
    });
  } catch {
    // Non-fatal: grant rows + state are already committed. Log a warning if a
    // logger is available so operators can diagnose a dropped feed notification.
    resolveLoggerOrNull(container)?.warn(
      `[achievements-spend-settled] notification failed for customer ${data.customer_id} open ${data.open_id} — grants committed, notification dropped`,
    );
  }
}

// Resolve the container logger, or null when it is unavailable (e.g. a unit-test
// container). Mirrors vip-spend-settled.ts.
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

import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { globepayEnabled } from '../modules/packs/globepay-deposit';
import {
  GlobePayError,
  getDepositDetail,
  globepayConfigFromEnv,
} from '../modules/packs/globepay-client';
import { topupIdempotencyReference } from '../modules/packs/topup';
import { notifyFeed } from '../modules/packs/notify-feed';
import { topupFeedKey } from '../modules/packs/feed-events';
import {
  GLOBEPAY_RECONCILE_BATCH,
  reconcileAction,
  unknownDepositAction,
} from '../modules/packs/globepay-reconcile';

/**
 * GlobePay365 deposit reconciliation.
 *
 * The callback is fire-and-forget over the public internet: one dropped POST
 * (our deploy, their retry budget, a DNS blip) means a customer paid and never
 * got credit, permanently, with nothing in the system that would notice. This
 * sweep is the safety net — GetDepositDetail is the authoritative read, and the
 * provider's own guidance is to requery rather than trust a callback.
 *
 * Crediting goes through the SAME idempotency anchor as the callback route
 * (signed MerchantTransactionId), so a callback and a sweep racing on the same
 * deposit produce exactly one credit — whichever gets there first.
 */
export default async function globepayReconcileJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (!globepayEnabled()) return;

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const config = globepayConfigFromEnv();
  const now = new Date();

  // Oldest first (the status+created_at index): a backlog drains over several
  // runs instead of starving the earliest deposits.
  const outstanding = await packs.listGlobePayDeposits(
    { status: 'pending' },
    { take: GLOBEPAY_RECONCILE_BATCH, order: { created_at: 'ASC' } },
  );
  if (outstanding.length === 0) return;

  let settled = 0;
  let failed = 0;
  let expired = 0;

  for (const deposit of outstanding) {
    try {
      let action;
      try {
        const detail = await getDepositDetail(
          deposit.merchant_transaction_id,
          config,
        );
        action = reconcileAction({
          state: detail.state,
          amount: Number(detail.amount),
          createdAt: new Date(deposit.created_at),
          now,
        });
      } catch (error) {
        // A deposit they have never heard of requeries as a 400 "Not found"
        // (observed on staging — NOT the documented PMT10016). That means
        // SubmitDeposit never took, so nobody can ever pay it.
        const notFound =
          error instanceof GlobePayError &&
          (error.httpStatus === 400 || error.has('PMT10016'));
        if (!notFound) throw error;
        action = unknownDepositAction(new Date(deposit.created_at), now);
      }

      if (action.kind === 'wait') continue;

      if (action.kind === 'settle') {
        const mutation = await packs.mutateCreditAtomic({
          customerId: deposit.customer_id,
          amount: action.amount,
          reason: 'topup',
          reference:
            deposit.gateway_transaction_id ?? deposit.merchant_transaction_id,
          // SAME anchor as the callback route, so a callback that arrives while
          // this sweep runs cannot produce a second credit.
          idempotencyReference: topupIdempotencyReference(
            deposit.customer_id,
            deposit.merchant_transaction_id,
          ),
        });

        await packs.updateGlobePayDeposits({
          selector: { id: deposit.id, status: 'pending' },
          data: {
            status: 'settled',
            amount_settled: action.amount,
            settled_at: now,
          },
        });
        settled += 1;

        logger.warn(
          `[globepay-reconcile] credited ${deposit.merchant_transaction_id} from a REQUERY, not a callback — the callback for this deposit was never received`,
        );

        if (!mutation.replayed) {
          try {
            await notifyFeed(container, {
              receiverId: deposit.customer_id,
              template: 'topup_credited',
              data: {
                amount_myr: action.amount,
                reference:
                  deposit.gateway_transaction_id ??
                  deposit.merchant_transaction_id,
              },
              idempotencyKey: topupFeedKey(deposit.merchant_transaction_id),
            });
          } catch {
            // Never fail a committed credit over a notification.
          }
        }
        continue;
      }

      // 'fail' (the gateway says so) and 'expire' (non-final but too old to keep
      // chasing) both close the row without touching the ledger. Conditional on
      // status so a callback that settled it mid-sweep is never overwritten.
      await packs.updateGlobePayDeposits({
        selector: { id: deposit.id, status: 'pending' },
        data: { status: 'failed' },
      });
      if (action.kind === 'fail') failed += 1;
      else expired += 1;
    } catch (error) {
      // One bad deposit must not abort the sweep — the next one may be a
      // customer waiting on credit. It stays pending and is retried next run.
      logger.error(
        `[globepay-reconcile] ${deposit.merchant_transaction_id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (settled || failed || expired) {
    logger.info(
      `[globepay-reconcile] swept ${outstanding.length}: ${settled} settled, ${failed} failed, ${expired} expired`,
    );
  }
}

export const config = {
  name: 'globepay-reconcile',
  // Every 10 minutes: their cashier times out in 10, so this is roughly one
  // sweep per deposit lifetime — fast enough that a customer whose callback was
  // dropped waits minutes, not hours.
  schedule: '*/10 * * * *',
};

import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  GLOBEPAY_MAX_RM,
  globepayEnabled,
} from '../modules/packs/globepay-deposit';
import {
  getDepositDetail,
  globepayConfigFromEnv,
} from '../modules/packs/globepay-client';
import { topupIdempotencyReference } from '../modules/packs/topup';
import { notifyFeed } from '../modules/packs/notify-feed';
import { sendTopupReceipt } from '../modules/packs/topup-receipt';
import { topupFeedKey } from '../modules/packs/feed-events';
import {
  GLOBEPAY_EXPIRED_RETRY_BATCH,
  GLOBEPAY_EXPIRED_RETRY_MS,
  GLOBEPAY_RECONCILE_BATCH,
  ambiguousRefusalAction,
  classifyRequeryError,
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
  const pending = await packs.listGlobePayDeposits(
    { status: 'pending' },
    { take: GLOBEPAY_RECONCILE_BATCH, order: { created_at: 'ASC' } },
  );

  // Second, smaller tier: deposits we gave up chasing. 'expired' means the
  // gateway never ruled on it, so a bank transfer can still land afterwards —
  // without this tier that row would never be requeried again and the payment
  // would be lost silently. Bounded on BOTH axes so it can never grow into a
  // full-table scan: a 7-day age window (same ['status','created_at'] index)
  // and a batch a fifth the size of the live queue.
  const revivable = await packs.listGlobePayDeposits(
    {
      status: 'expired',
      created_at: { $gte: new Date(now.getTime() - GLOBEPAY_EXPIRED_RETRY_MS) },
    },
    { take: GLOBEPAY_EXPIRED_RETRY_BATCH, order: { created_at: 'ASC' } },
  );

  const outstanding = [...pending, ...revivable];
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
        // A refusal we cannot attribute must never write a row off — a rotated
        // key or a wrong merchant code returns the same bare 400 a genuine
        // not-found does, so reading every 400 as "never existed" turned one
        // credential breakage into a write-off of every pending deposit.
        // classifyRequeryError encodes the taxonomy (and why it is this
        // conservative); this branch only reacts to it.
        const refusal = classifyRequeryError(error);
        if (refusal.kind === 'rethrow') throw error;
        if (refusal.kind === 'ambiguous') {
          logger.error(
            `[globepay-reconcile] requery refused ${deposit.merchant_transaction_id} with an unattributable 400 (${
              error instanceof Error ? error.message : String(error)
            }) — NOT writing it off; check merchant credentials`,
          );
          // 'wait' until the give-up bound, then 'expire' — deliberately reusing
          // existing ReconcileAction kinds rather than adding one: the write-off
          // branch below is an explicit `if`, and a new kind is exactly what
          // could one day be forgotten there. The bound matters as much as the
          // waiting does: without it these rows sit in the oldest-first window
          // forever and starve the sweep of fresh deposits. See
          // ambiguousRefusalAction.
          action = ambiguousRefusalAction(new Date(deposit.created_at), now);
        } else {
          action = unknownDepositAction(
            new Date(deposit.created_at),
            now,
            Boolean(deposit.gateway_transaction_id),
          );
          if (deposit.gateway_transaction_id) {
            // Mirrors the withdrawal sweep: their D… id is on our row, so the
            // deposit provably exists on their side and "unknown" is our own
            // config being broken, never non-existence.
            logger.error(
              `[globepay-reconcile] requery says ${deposit.merchant_transaction_id} is unknown, but it HAS gateway id ${deposit.gateway_transaction_id} — refusing to expire it; check merchant credentials`,
            );
          }
        }
      }

      if (action.kind === 'wait') continue;

      // Requeried above the deposit ceiling. Quarantine, exactly as the callback
      // route does: no credit, and NOT written off — the row keeps whatever
      // status it already had, so a 'pending' one is seen again next sweep and
      // an 'expired' one (reached via the second scan tier) is seen again for as
      // long as it stays inside the retry window. Either way an operator can
      // settle it by hand.
      if (action.kind === 'quarantine') {
        logger.error(
          `[globepay-reconcile] ${deposit.merchant_transaction_id} requeried at ${action.amount}, above the RM ${GLOBEPAY_MAX_RM} deposit ceiling — not credited, not written off; left ${deposit.status} for manual settlement`,
        );
        continue;
      }

      if (action.kind === 'settle') {
        const mutation = await packs.topUpCreditsWithLedger({
          customerId: deposit.customer_id,
          amount: action.amount,
          reason: 'topup',
          ledgerPaymentMethod: deposit.payment_method_code,
          ledgerGatewayRef:
            deposit.gateway_transaction_id ?? deposit.merchant_transaction_id,
          reference:
            deposit.gateway_transaction_id ?? deposit.merchant_transaction_id,
          // SAME anchor as the callback route, so a callback that arrives while
          // this sweep runs cannot produce a second credit.
          idempotencyReference: topupIdempotencyReference(
            deposit.customer_id,
            deposit.merchant_transaction_id,
          ),
        });

        // Conditional on the status we READ, not a literal 'pending' — the
        // same reasoning as the callback route's recovery flip
        // (api/hooks/globepay/deposit/route.ts:308): the second scan tier
        // reaches here with an 'expired' row, and a hardcoded 'pending'
        // selector would match nothing, leaving the credit committed while the
        // row still said we had given up on it. Matching deposit.status keeps
        // the concurrency guard intact — a row another worker moved since we
        // read it still no-ops.
        await packs.updateGlobePayDeposits({
          selector: { id: deposit.id, status: deposit.status },
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

          // Same receipt the callback would have sent. The shared idempotency
          // anchor means a late callback cannot produce a second one.
          await sendTopupReceipt(container, {
            customerId: deposit.customer_id,
            amount: action.amount,
            reference:
              deposit.gateway_transaction_id ??
              deposit.merchant_transaction_id,
            merchantTransactionId: deposit.merchant_transaction_id,
            paymentMethodCode: deposit.payment_method_code,
          });
        }
        continue;
      }

      // 'fail' (the gateway says so) and 'expire' (non-final but too old to keep
      // chasing) both close the row without touching the ledger — but into
      // DIFFERENT statuses. 'failed' is terminal; 'expired' is not, and the
      // second scan tier above keeps requerying it, because the gateway never
      // actually ruled on it and a late bank transfer must still be creditable.
      // Conditional on the status we read so a callback that settled it
      // mid-sweep is never overwritten.
      //
      // Named explicitly rather than left as the fallthrough: writing a row off
      // is the one irreversible thing this loop does, and a fallthrough would
      // silently swallow any ReconcileAction added later (tsc cannot catch it).
      if (action.kind === 'fail' || action.kind === 'expire') {
        const next = action.kind === 'fail' ? 'failed' : 'expired';
        // An already-expired row re-expiring is a no-op; skip it so the sweep
        // does not report the same row as newly expired every ten minutes.
        if (deposit.status === next) continue;
        await packs.updateGlobePayDeposits({
          selector: { id: deposit.id, status: deposit.status },
          data: { status: next },
        });
        if (action.kind === 'fail') failed += 1;
        else expired += 1;
      }
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

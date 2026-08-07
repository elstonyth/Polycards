import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  globepayWithdrawalsEnabled,
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../modules/packs/globepay-withdrawal';
import {
  GlobePayError,
  getWithdrawalDetail,
  globepayConfigFromEnv,
} from '../modules/packs/globepay-client';
import { notifyFeed } from '../modules/packs/notify-feed';
import { withdrawalFeedKey } from '../modules/packs/feed-events';
import { sendWithdrawalReceipt } from '../modules/packs/withdrawal-receipt';
import {
  GLOBEPAY_RECONCILE_BATCH,
  GLOBEPAY_WD_SLOW_AFTER_MS,
  unknownWithdrawalAction,
  withdrawalReconcileAction,
} from '../modules/packs/globepay-reconcile';

/**
 * GlobePay365 withdrawal reconciliation.
 *
 * Higher stakes than the deposit sweep: every pending row here is a customer
 * balance already debited. A lost withdrawal callback must resolve to exactly
 * one of "the bank got it" (settle) or "the money comes back" (refund) — and
 * a crash between the ledger debit and SubmitWithdrawal resolves here too,
 * via the gateway's "not found" answer once the row is stale.
 *
 * The refund shares the callback route's idempotency anchor, so a sweep and a
 * late callback racing on the same payout refund exactly once.
 */
export default async function globepayWithdrawalReconcileJob(
  container: MedusaContainer,
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (!globepayWithdrawalsEnabled()) return;

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const config = globepayConfigFromEnv();
  const now = new Date();

  const outstanding = await packs.listGlobePayWithdrawals(
    { status: 'pending' },
    { take: GLOBEPAY_RECONCILE_BATCH, order: { created_at: 'ASC' } },
  );
  if (outstanding.length === 0) return;

  let settled = 0;
  let refunded = 0;

  for (const withdrawal of outstanding) {
    try {
      let action;
      let gatewayStatus: number | null = null;
      try {
        const detail = await getWithdrawalDetail(
          withdrawal.merchant_transaction_id,
          config,
        );
        gatewayStatus = detail.statusId;
        action = withdrawalReconcileAction(detail.state);
      } catch (error) {
        const notFound =
          error instanceof GlobePayError &&
          (error.httpStatus === 400 || error.has('PMT10016'));
        if (!notFound) throw error;
        if (withdrawal.gateway_transaction_id) {
          // The payout provably exists (their W… id is on our row) — a 400
          // requery is OUR config being broken, never non-existence.
          logger.error(
            `[globepay-wd-reconcile] requery 400 for ${withdrawal.merchant_transaction_id} which HAS gateway id ${withdrawal.gateway_transaction_id} — refusing the unknown-refund path; check merchant credentials`,
          );
        }
        action = unknownWithdrawalAction(
          new Date(withdrawal.created_at),
          now,
          Boolean(withdrawal.gateway_transaction_id),
        );
      }

      if (action.kind === 'wait') {
        const age = now.getTime() - new Date(withdrawal.created_at).getTime();
        if (age > GLOBEPAY_WD_SLOW_AFTER_MS) {
          logger.error(
            `[globepay-wd-reconcile] payout ${withdrawal.merchant_transaction_id} still unresolved after ${Math.round(age / 3_600_000)}h — customer ${withdrawal.customer_id} has RM ${withdrawal.amount} in limbo; chase the provider`,
          );
        }
        continue;
      }

      if (action.kind === 'settle') {
        // The emailed record — BEFORE the terminal row update: once the row
        // leaves 'pending' this sweep never selects it again and a retried
        // callback early-returns, so a crash between the update and a later
        // send would lose the email forever. A crash after this send re-runs
        // the branch next sweep and the notification module's unique
        // idempotency_key dedupes. Non-throwing.
        await sendWithdrawalReceipt(container, {
          customerId: withdrawal.customer_id,
          amount: Number(withdrawal.amount),
          // `||`, not `??` — an empty-string gateway id must fall through, or
          // the template fails closed AFTER the idempotency key is burned and
          // the email is permanently unsent.
          reference:
            withdrawal.gateway_transaction_id ||
            withdrawal.merchant_transaction_id,
          merchantTransactionId: withdrawal.merchant_transaction_id,
          outcome: 'paid',
        });
        await packs.updateGlobePayWithdrawals({
          selector: { id: withdrawal.id, status: 'pending' },
          data: {
            status: 'settled',
            gateway_status: gatewayStatus,
            settled_at: now,
          },
        });
        settled += 1;
        logger.warn(
          `[globepay-wd-reconcile] settled ${withdrawal.merchant_transaction_id} from a REQUERY — the callback for this payout was never received`,
        );
        try {
          await notifyFeed(container, {
            receiverId: withdrawal.customer_id,
            template: 'withdrawal_paid',
            data: {
              amount_myr: Number(withdrawal.amount),
              reference:
                withdrawal.gateway_transaction_id ??
                withdrawal.merchant_transaction_id,
            },
            idempotencyKey: withdrawalFeedKey(
              withdrawal.merchant_transaction_id,
              'paid',
            ),
          });
        } catch {
          // Never fail a committed settle over a notification.
        }
        continue;
      }

      // refund: gateway says failed, or it never heard of a stale row.
      //
      // Guard against refunding a debit that never landed: a crash between
      // the row insert and mutateCreditAtomic leaves a pending row with NO
      // debit, and "refunding" it would mint money. A refund is only owed if
      // the wd: debit row exists.
      const [debitRow] = await packs.listCreditTransactions(
        {
          customer_id: withdrawal.customer_id,
          source_transaction_id: withdrawalIdempotencyReference(
            withdrawal.customer_id,
            withdrawal.merchant_transaction_id,
          ),
        },
        { take: 1 },
      );
      if (!debitRow) {
        await packs.updateGlobePayWithdrawals({
          selector: { id: withdrawal.id, status: 'pending' },
          data: { status: 'failed', gateway_status: gatewayStatus },
        });
        logger.warn(
          `[globepay-wd-reconcile] closed ${withdrawal.merchant_transaction_id} without a refund — no debit ever landed for it`,
        );
        continue;
      }
      const refund = await packs.withdrawCreditsWithLedger({
        customerId: withdrawal.customer_id,
        amount: Number(withdrawal.amount),
        reason: 'cashout',
        reference:
          withdrawal.gateway_transaction_id ??
          withdrawal.merchant_transaction_id,
        idempotencyReference: withdrawalRefundReference(
          withdrawal.customer_id,
          withdrawal.merchant_transaction_id,
        ),
        ledger: {
          outcome: 'refunded',
          bankCode: withdrawal.bank_code,
          accountNumber: withdrawal.account_number,
          gatewayRef:
            withdrawal.gateway_transaction_id ??
            withdrawal.merchant_transaction_id,
        },
      });
      // The emailed record — after the refund commit, BEFORE the terminal row
      // update, outside any !replayed guard: once the row leaves 'pending'
      // nothing re-runs this branch, so a crash between the update and a
      // later send would lose the email forever. A crash after this send
      // re-runs the branch next sweep (the refund replays, the notification
      // module's unique idempotency_key dedupes the email). Non-throwing.
      await sendWithdrawalReceipt(container, {
        customerId: withdrawal.customer_id,
        amount: Number(withdrawal.amount),
        reference:
          withdrawal.gateway_transaction_id ||
          withdrawal.merchant_transaction_id,
        merchantTransactionId: withdrawal.merchant_transaction_id,
        outcome: 'refunded',
      });
      await packs.updateGlobePayWithdrawals({
        selector: { id: withdrawal.id, status: 'pending' },
        data: { status: 'failed', gateway_status: gatewayStatus },
      });
      refunded += 1;
      if (!refund.replayed) {
        try {
          await notifyFeed(container, {
            receiverId: withdrawal.customer_id,
            template: 'withdrawal_refunded',
            data: {
              amount_myr: Number(withdrawal.amount),
              reference:
                withdrawal.gateway_transaction_id ??
                withdrawal.merchant_transaction_id,
            },
            idempotencyKey: withdrawalFeedKey(
              withdrawal.merchant_transaction_id,
              'refunded',
            ),
          });
        } catch {
          // Never fail a committed refund over a notification.
        }
      }
    } catch (error) {
      // One bad payout must not abort the sweep. It stays pending and is
      // retried next run.
      logger.error(
        `[globepay-wd-reconcile] ${withdrawal.merchant_transaction_id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (settled || refunded) {
    logger.info(
      `[globepay-wd-reconcile] swept ${outstanding.length}: ${settled} settled, ${refunded} refunded`,
    );
  }
}

export const config = {
  name: 'globepay-withdrawal-reconcile',
  // Every 10 minutes, same cadence as deposits — a customer whose payout
  // callback was dropped waits minutes for resolution, not hours.
  schedule: '*/10 * * * *',
};

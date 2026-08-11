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
  GLOBEPAY_FAST_BATCH,
  GLOBEPAY_FAST_WINDOW_MS,
  GLOBEPAY_RECONCILE_BATCH,
  ambiguousRefusalAction,
  classifyRequeryError,
  isFullSweepDue,
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
// Last run that covered every tier. Module-scoped rather than persisted: the
// worker is instance_count 1 and BullMQ runs scheduled jobs at concurrency 1,
// so there is exactly one reader/writer, and a restart resets this to null,
// which forces a full sweep on the next run — more coverage, never less.
let lastFullSweepAt: Date | null = null;

export default async function globepayReconcileJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (!globepayEnabled()) return;

  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const config = globepayConfigFromEnv();
  const now = new Date();

  // TWO cadences in one job. Most runs are the fast tier: only deposits young
  // enough that a customer is plausibly still watching their balance. Every
  // tenth run is the full sweep the slow tiers below were sized for. See
  // isFullSweepDue and GLOBEPAY_FAST_WINDOW_MS for why the split, not the cron,
  // carries this decision.
  const fullSweep = isFullSweepDue(now, lastFullSweepAt);
  // Stamped BEFORE the work, not after: a full sweep that throws part way still
  // counts as attempted, so a persistently failing run cannot turn every
  // subsequent run into a full sweep and hammer the gateway.
  if (fullSweep) lastFullSweepAt = now;

  // Oldest first (the status+created_at index): a backlog drains over several
  // runs instead of starving the earliest deposits.
  const pending = await packs.listGlobePayDeposits(
    fullSweep
      ? { status: 'pending' }
      : {
          status: 'pending',
          created_at: {
            $gte: new Date(now.getTime() - GLOBEPAY_FAST_WINDOW_MS),
          },
        },
    {
      take: fullSweep ? GLOBEPAY_RECONCILE_BATCH : GLOBEPAY_FAST_BATCH,
      order: { created_at: 'ASC' },
    },
  );

  // Second, smaller tier: deposits we gave up chasing. 'expired' means the
  // gateway never ruled on it, so a bank transfer can still land afterwards —
  // without this tier that row would never be requeried again and the payment
  // would be lost silently. Bounded on BOTH axes so it can never grow into a
  // full-table scan: a 7-day age window (same ['status','created_at'] index)
  // and a batch a fifth the size of the live queue. Full sweeps only, on top
  // of that: a row we already gave up chasing has, by definition, nobody
  // waiting on the next sixty seconds.
  const revivable = !fullSweep
    ? []
    : await packs.listGlobePayDeposits(
        {
          status: 'expired',
          created_at: {
            $gte: new Date(now.getTime() - GLOBEPAY_EXPIRED_RETRY_MS),
          },
        },
        // NEWEST first, unlike the live queue above. Requerying an 'expired' row
        // leaves it 'expired' (the `deposit.status === next` no-op below), so the row
        // stays in this population forever. Oldest-first therefore pinned the batch to
        // the same ten rows closest to ageing OUT of the window and never reached one
        // that had just expired — the exact case this tier exists for, since a late
        // bank transfer lands hours after we gave up, not days. Newest-first asks
        // about the rows most likely to have changed, and matches what
        // GLOBEPAY_AMBIGUOUS_GIVEUP_MS already documents: a row aged out by the
        // ambiguous bound has spent a week yielding nothing and is not worth ten more
        // requeries. No column records WHEN a row expired, so created_at is the only
        // sort key available.
        { take: GLOBEPAY_EXPIRED_RETRY_BATCH, order: { created_at: 'DESC' } },
      );

  const outstanding = [...pending, ...revivable];
  if (outstanding.length === 0) return;

  let settled = 0;
  let failed = 0;
  let expired = 0;
  let quarantined = 0;

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
      //
      // NOTE: this is the sweep's FIRST non-terminating outcome. Before it,
      // every pending deposit eventually reached settled or failed; a
      // quarantined row is now requeried every run forever and permanently
      // occupies a slot in the oldest-first GLOBEPAY_RECONCILE_BATCH window.
      // Expected N is 0 (the gateway caps at the same RM 10,000), but if that
      // ever stops holding, this is the property that has to be revisited.
      if (action.kind === 'quarantine') {
        quarantined += 1;
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

        // Same receipt the callback would have sent — after the credit
        // commit, BEFORE the terminal row update, outside the !replayed
        // guard: once the row leaves 'pending' this sweep never selects it
        // again and a retried callback early-returns, so a crash between the
        // update and a later send would lose the email forever. A crash after
        // this send re-runs the branch next sweep (the credit replays, the
        // notification module's unique idempotency_key dedupes). Non-throwing.
        await sendTopupReceipt(container, {
          customerId: deposit.customer_id,
          amount: action.amount,
          // `||`, not `??` — an empty-string gateway id must fall through, or
          // the template fails closed AFTER the idempotency key is burned and
          // the email is permanently unsent.
          reference:
            deposit.gateway_transaction_id ||
            deposit.merchant_transaction_id,
          merchantTransactionId: deposit.merchant_transaction_id,
          paymentMethodCode: deposit.payment_method_code,
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

  // Quarantines are counted in the summary as well as logged individually:
  // this line is what an operator actually reads, and a deposit held back for
  // manual settlement must not be invisible in it.
  if (settled || failed || expired || quarantined) {
    logger.info(
      `[globepay-reconcile] swept ${outstanding.length}: ${settled} settled, ${failed} failed, ${expired} expired, ${quarantined} quarantined`,
    );
  }
}

export const config = {
  name: 'globepay-reconcile',
  // Every minute. It used to be every ten — "roughly one sweep per deposit
  // lifetime", which was sized for a world where the callback did the crediting
  // and this was only the safety net. In production the callback never arrives,
  // so this sweep is the ONLY thing that credits a payment and its period is
  // the customer's wait: ten minutes of it, measured on a real RM 300 top-up on
  // 2026-08-11 (paid 09:04:11Z, credited 09:10:01Z).
  //
  // The extra runs are cheap because they are not the same sweep: isFullSweepDue
  // keeps the stale and 'expired' tiers on the old ten-minute cadence, so a
  // minute-cadence run costs one requery per deposit started in the last twenty
  // minutes — normally zero.
  schedule: '* * * * *',
};

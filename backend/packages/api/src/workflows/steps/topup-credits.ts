import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  mockCharge,
  mockTopupAllowed,
  topUpAmountError,
  topupIdempotencyReference,
} from '../../modules/packs/topup';

export type TopUpCreditsInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
  /** Raw body value — validated HERE so the rule lives with the money logic. */
  amount: unknown;
  /**
   * REQUIRED client Idempotency-Key (from the request header). A replayed
   * top-up with the same key returns the original result instead of crediting
   * again. Mandatory since the 2026-07-07 audit — a real PSP retry without a
   * key would double-credit.
   */
  idempotency_key?: string;
};

export type TopUpResult = {
  /** MYR (RM) credited (decimal, never cents). */
  amount: number;
  /** The gateway's charge reference (mock today, real later). */
  reference: string;
  /** The customer's new credit balance (Σ ledger). */
  balance: number;
};

// topup-credits — buy site credit through the payment gateway seam: charge
// the gateway (mock — always approves except the .13 demo decline), then
// append a positive ledger row. Real money never moves; the ledger row IS the
// purchase record (reason "topup", gateway reference, no pull).
export const topUpCreditsStep = createStep(
  'topup-credits',
  async (input: TopUpCreditsInput, { container }) => {
    // Security gate (audit 2026-06-23): the mock gateway mints free spendable
    // credit, so it must be inert in production unless an operator explicitly
    // opts in (ALLOW_MOCK_TOPUP=true). Fail closed BEFORE charging/validating.
    if (!mockTopupAllowed()) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Top-ups are temporarily unavailable.',
      );
    }

    // Idempotency-Key is now MANDATORY (audit 2026-07-07): a keyless retry
    // against a real PSP would double-credit, so fail closed before touching
    // the amount or the gateway. The message is user-facing (sim finding
    // P3-6): the storefront always sends the key, so a missing one means a
    // broken/stale client — tell the human what to do, not the protocol.
    if (!input.idempotency_key || input.idempotency_key.trim() === '') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'We could not start your top-up — please refresh the page and try again.',
      );
    }

    const invalid = topUpAmountError(input.amount);
    if (invalid) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
    }
    const amount = input.amount as number;

    // Deterministic, customer-scoped anchor so a replayed request with the same
    // Idempotency-Key dedupes under the per-customer lock (no double-credit).
    const idempotencyReference = topupIdempotencyReference(
      input.customer_id,
      input.idempotency_key,
    );

    // Gateway first: a declined charge must leave NO ledger row. The mock is
    // synchronous and infallible, but the real gateway slots in here — keep
    // the charge-then-record order. (A real gateway must ALSO pass the
    // idempotency key to the PSP so the upstream charge is exactly-once.)
    const charge = mockCharge({ amount, customer_id: input.customer_id });
    if (!charge.ok) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        charge.declined_reason,
      );
    }

    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // Phase 1b: route through the locked mutation so the row is serialized with
    // pack-opens AND stamped with external_funded_cents = +amount (external
    // money in). Returns the post-write balance — no separate Σ-ledger read.
    // When idempotencyReference is set, a replay returns the original row
    // (replayed=true) instead of crediting again.
    const {
      id,
      balance,
      amount: creditedAmount,
      replayed,
    } = await packs.mutateCreditAtomic({
      customerId: input.customer_id,
      amount,
      reason: 'topup',
      reference: charge.reference,
      idempotencyReference,
    });

    const result: TopUpResult = {
      // On a replay this is the ORIGINAL credited amount, not the (ignored)
      // amount on the replayed request body.
      amount: creditedAmount,
      // The gateway/charge reference is the public reconciliation handle; the
      // idempotency anchor is internal (stored in source_transaction_id).
      reference: charge.reference,
      balance,
    };
    return new StepResponse(result, { creditTransactionId: id, replayed });
  },
  async (
    data: { creditTransactionId: string; replayed?: boolean } | undefined,
    { container },
  ) => {
    if (!data) return;
    // A replay credited NOTHING (it returned the pre-existing row), so undoing
    // it would wrongly delete the ORIGINAL top-up. Only compensate a real write.
    if (data.replayed) return;
    // Mirror buyback-pull: the ledger row is the only mutation, so undo is a
    // single delete. (A real gateway adds a refund call here.)
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
  },
);

export default topUpCreditsStep;

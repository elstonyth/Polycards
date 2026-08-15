import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  adjustAmountError,
  adjustDailyMintError,
  adjustNoteError,
  ADJUST_DAILY_MINT_MAX_RM_DEFAULT,
} from '../../modules/packs/credit-adjust';
import { nonNegativeIntFromEnv } from '../../api/utils/rate-limit';

export type AdjustCreditsInput = {
  customer_id: string;
  /** Raw body values — validated HERE so the rules live with the money logic. */
  amount: unknown;
  note: unknown;
  /** Server-derived actor id from req.auth_context.actor_id — never from body. */
  admin_id: string;
};

export type AdjustCreditsResult = {
  /** MYR (RM) applied (decimal, signed: positive grant, negative deduction). */
  amount: number;
  /** The customer's new credit balance (Σ ledger). */
  balance: number;
};

// adjust-credits — operator grant/refund/clawback from the support view: one
// signed ledger row (reason "adjustment", note in "reference"). The balance
// floor is RM 0 — a deduction larger than the current balance is refused before
// anything is written. The check + write go through packs.mutateCreditAtomic,
// which serializes per-customer credit mutations under an advisory lock so a
// deduct racing another deduct or a pack-open can't breach the floor (#4).
export const adjustCreditsStep = createStep(
  'adjust-credits',
  async (input: AdjustCreditsInput, { container }) => {
    const invalidAmount = adjustAmountError(input.amount);
    if (invalidAmount) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, invalidAmount);
    }
    const invalidNote = adjustNoteError(input.note);
    if (invalidNote) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, invalidNote);
    }
    const amount = input.amount as number;
    const note = (input.note as string).trim();

    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    // Rolling-24h GLOBAL mint ceiling, checked BEFORE the write. adjustAmountError
    // above bounds a single call; this bounds the day across all admins and all
    // customers, because the per-call ceiling plus the admin limiter alone still
    // permits ~RM 200,000,000/min of minted, immediately-withdrawable credit.
    //
    // Positive amounts only: clawbacks are never blocked, and skipping the query
    // for them means a deduction does not even pay for the read.
    const amountCents = Math.round(amount * 100);
    if (amountCents > 0) {
      // nonNegativeIntFromEnv, NOT positiveIntFromEnv: 0 must mean "refuse every
      // grant" (the incident stop lever), not "fall back to the default".
      const capCents =
        nonNegativeIntFromEnv(
          'ADJUST_DAILY_MINT_MAX_RM',
          ADJUST_DAILY_MINT_MAX_RM_DEFAULT,
        ) * 100;
      const windowCents = await packs.rollingAdjustmentMintCents();
      const refusal = adjustDailyMintError(windowCents, amountCents, capCents);
      if (refusal) {
        // The alerting seam: one structured line per refusal. No customer id —
        // the ceiling is global and this lands in shared operator logs.
        console.warn(
          JSON.stringify({
            event: 'adjust_credit.daily_mint_refused',
            admin_id: input.admin_id,
            attempted_cents: amountCents,
            window_cents: windowCents,
            cap_cents: capCents,
          }),
        );
        // NOT_ALLOWED — a policy refusal, not malformed input. Surfaces as HTTP
        // 400 here, same as the RM 0 balance floor in mutateCreditAtomic.
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, refusal);
      }
    }

    // The read above runs OUTSIDE the write transaction and outside the
    // per-customer `credit:` advisory lock. That lock cannot serialize a GLOBAL
    // cap anyway — two admins minting to two different customers take two
    // different keys — so concurrent mints are serialized only by the admin
    // action limiter. This is enforcement-at-margin, not to-the-cent: it bounds
    // the blast radius of a runaway token, it is not a distributed counter.

    // Atomic write: the credit ledger row AND an admin_action_audit row are
    // written together in the same transaction inside adminAdjustCredit, so
    // both commit or neither does. The advisory-lock serialisation from
    // mutateCreditAtomic is preserved (adminAdjustCredit calls it internally).
    const { id, balance } = await packs.adminAdjustCredit({
      customerId: input.customer_id,
      amount,
      note,
      adminId: input.admin_id,
    });

    const result: AdjustCreditsResult = { amount, balance };
    return new StepResponse(result, { creditTransactionId: id });
  },
  async (data: { creditTransactionId: string } | undefined, { container }) => {
    if (!data) return;
    // adjustment rows are never commission-backed, so the guarded path is safe
    // and removes the last caller of the raw base-delete (Task 11 seals it).
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
    await packs.deleteLedgerEntryByRef('AD', data.creditTransactionId);
  },
);

export default adjustCreditsStep;

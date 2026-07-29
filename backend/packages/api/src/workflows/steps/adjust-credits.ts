import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  adjustAmountError,
  adjustNoteError,
} from '../../modules/packs/credit-adjust';

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

import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import { mockCharge, topUpAmountError } from "../../modules/packs/topup";

export type TopUpCreditsInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
  /** Raw body value — validated HERE so the rule lives with the money logic. */
  amount: unknown;
};

export type TopUpResult = {
  /** USD credited (decimal, never cents). */
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
  "topup-credits",
  async (input: TopUpCreditsInput, { container }) => {
    const invalid = topUpAmountError(input.amount);
    if (invalid) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
    }
    const amount = input.amount as number;

    // Gateway first: a declined charge must leave NO ledger row. The mock is
    // synchronous and infallible, but the real gateway slots in here — keep
    // the charge-then-record order.
    const charge = mockCharge({ amount, customer_id: input.customer_id });
    if (!charge.ok) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        charge.declined_reason
      );
    }

    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // Phase 1b: route through the locked mutation so the row is serialized with
    // pack-opens AND stamped with external_funded_cents = +amount (external
    // money in). Returns the post-write balance — no separate Σ-ledger read.
    const { id, balance } = await packs.mutateCreditAtomic({
      customerId: input.customer_id,
      amount,
      reason: "topup",
      reference: charge.reference,
    });

    const result: TopUpResult = {
      amount,
      reference: charge.reference,
      balance,
    };
    return new StepResponse(result, { creditTransactionId: id });
  },
  async (data: { creditTransactionId: string } | undefined, { container }) => {
    if (!data) return;
    // Mirror buyback-pull: the ledger row is the only mutation, so undo is a
    // single delete. (A real gateway adds a refund call here.)
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
  }
);

export default topUpCreditsStep;

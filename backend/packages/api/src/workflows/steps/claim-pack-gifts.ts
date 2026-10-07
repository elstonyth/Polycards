import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type ClaimPackGiftsInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
  pack_id: string; // = Pack.slug
  /** How many rows of this open the screen showed as "Vault" (0 = none). */
  gifts: number;
  open_id: string;
};

export type ClaimPackGiftsResult = { gift_ids: string[] };

type CompensateData = { open_id: string } | undefined;

// claim-pack-gifts — spend the customer's gifted packs (spec 2026-10-07 §5)
// BEFORE the charge, so the batch charges only the rows the gifts do not
// cover. Claims EXACTLY `gifts` or refuses with 409 (nothing charged): a
// stale "Vault x1" screen is never silently billed the pack price.
// Compensation releases the claim by open_id — claim, open id AND any pull a
// later step stamped — so a rolled-back open leaves the gifts as they were.
export const claimPackGiftsStep = createStep<
  ClaimPackGiftsInput,
  ClaimPackGiftsResult,
  CompensateData
>(
  'claim-pack-gifts',
  async (input, { container }) => {
    if (input.gifts <= 0) {
      return new StepResponse({ gift_ids: [] }, undefined as CompensateData);
    }
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const gift_ids = await packs.claimPackGifts({
      customerId: input.customer_id,
      packSlug: input.pack_id,
      count: input.gifts,
      openId: input.open_id,
    });
    return new StepResponse({ gift_ids }, { open_id: input.open_id });
  },
  async (data, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.releasePackGifts(data.open_id);
  },
);

export default claimPackGiftsStep;

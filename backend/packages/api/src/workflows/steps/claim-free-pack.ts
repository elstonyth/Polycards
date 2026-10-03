import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../modules/packs/free-pack';
import { passesPhoneGate } from '../../api/utils/phone-verification-guard';

export type ClaimFreePackInput = { pack_id: string; customer_id: string };
export type ClaimFreePackResult = { free: boolean };
// The compensate payload. createStep's CompensateFn already adds `| undefined`
// (the step may return no payload), so this type must NOT include it — the
// StepResponse generic has to match the inferred TCompensateInput exactly.
type CompensateData = { customer_id: string };

// claim-free-pack — the free pack's "payment": consume the account's one-time
// claim BEFORE the charge seam. No-op ({ free: false }) for every non-free
// pack, so the step sits unconditionally in the open-pack composition (workflow
// bodies cannot branch). The UPDATE inside claimFreePack is a single
// conditional statement — the row lock serializes double-taps; the loser
// matches 0 rows and lands here as NOT_ALLOWED.
/** Exported for the unit spec (same idea as charge-pack-batch's invoke). */
export async function claimFreePackInvoke(
  input: ClaimFreePackInput,
  { container }: { container: MedusaContainer },
) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
  if (!pack || pack.category !== FREE_WELCOME_CATEGORY) {
    // Explicit generics on BOTH returns: inference would otherwise narrow
    // this branch to `{ free: false }`, and the free branch below would no
    // longer be assignable to the step's output type.
    return new StepResponse<ClaimFreePackResult, CompensateData>({
      free: false,
    });
  }
  // Freeze gate. A paid open inherits this from settleOpen (service.ts step
  // 1a), but a price-0 open never reaches it — chargePackOpenStep returns
  // early — so the free branch carries the check itself, with the SAME
  // helper and message so both opens fail identically. BEFORE the claim: a
  // refused open must leave the one-time claim unspent.
  if (await packs.isFrozen(input.customer_id)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This account is frozen.',
    );
  }
  // Phone gate (operator decision 2026-09-30): the free pack unlocks on a
  // verified phone — 90 unverified accounts had claimed one, six created within
  // five minutes. The SAME predicate as the money/goods gates, so the flag, the
  // verified stamp and partner exemptions behave identically. Eligibility is
  // still stamped at registration (no new grants to pre-feature accounts); this
  // only defers the claim. Also BEFORE the claim, for the freeze gate's reason.
  //
  // ponytail: deleting an account frees its phone, so delete + re-sign-up with
  // the same number can claim again (one paid open per cycle). Record claimed
  // phones if the data ever shows that loop.
  if (!(await passesPhoneGate(container, input.customer_id))) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Verify your phone number to claim your free pack.',
    );
  }
  const claimed = await packs.claimFreePack(input.customer_id);
  if (!claimed) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The free welcome pack is not available for this account (already claimed or not eligible).',
    );
  }
  return new StepResponse<ClaimFreePackResult, CompensateData>(
    { free: true },
    { customer_id: input.customer_id },
  );
}

export const claimFreePackStep = createStep(
  'claim-free-pack',
  claimFreePackInvoke,
  async (data: CompensateData | undefined, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.clearFreePackClaim(data.customer_id);
  },
);

export default claimFreePackStep;

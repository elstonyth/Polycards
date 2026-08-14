import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../modules/packs/free-pack';

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
export const claimFreePackStep = createStep(
  'claim-free-pack',
  async (input: ClaimFreePackInput, { container }) => {
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
  },
  async (data: CompensateData | undefined, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.clearFreePackClaim(data.customer_id);
  },
);

export default claimFreePackStep;

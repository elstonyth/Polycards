import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  FREE_PACK_SHARED_PHONE_MESSAGE,
  FREE_PACK_VERIFICATION_MESSAGE,
  FREE_WELCOME_CATEGORY,
} from '../../modules/packs/free-pack';

export type ClaimFreePackInput = { pack_id: string; customer_id: string };
export type ClaimFreePackResult = { free: boolean };
// The compensate payload. createStep's CompensateFn already adds `| undefined`
// (the step may return no payload), so this type must NOT include it — the
// StepResponse generic has to match the inferred TCompensateInput exactly.
type CompensateData = { customer_id: string };
// Same cast as api/utils/phone-claim.ts: `has_account` is a real column the
// generated filter type omits.
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

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
    // Anti-farm gate (spec 2026-10-06): a verified phone AND a real name on
    // file, so one welcome pack maps to one person staff can check against
    // Touch 'n Go. Unconditional — no PHONE_* flag, no partner exemption: it is
    // a business rule like one-phone-one-account, not part of the OTP rollback
    // lever. Also BEFORE the claim, so a refusal leaves the pack waiting for
    // them once they finish verifying.
    const { phoneVerified, realName } = await packs.getVerificationState(
      input.customer_id,
    );
    if (!phoneVerified || !realName) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        FREE_PACK_VERIFICATION_MESSAGE,
      );
    }
    // One phone, one welcome pack. assertPhoneUnclaimed (api/utils/phone-claim)
    // is a read-then-write with no lock or unique index, so concurrent
    // first-phone verifications replaying ONE OTP proof can land the same
    // number — each stamped verified — on many fresh accounts. That race is the
    // farming route this gate exists to close, so refuse here whatever put the
    // number on more than one real account; customer service sorts the
    // genuine case out. Same has_account scoping as phone-claim.ts.
    const customers = container.resolve<ICustomerModuleService>(
      Modules.CUSTOMER,
    );
    const { phone } = await customers.retrieveCustomer(input.customer_id, {
      select: ['phone'],
    });
    const holders = phone
      ? await customers.listCustomers(
          { phone, has_account: true } as unknown as CustomerFilters,
          { select: ['id'], take: 2 },
        )
      : [];
    if (!phone || holders.length > 1) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        FREE_PACK_SHARED_PHONE_MESSAGE,
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
  },
  async (data: CompensateData | undefined, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.clearFreePackClaim(data.customer_id);
  },
);

export default claimFreePackStep;

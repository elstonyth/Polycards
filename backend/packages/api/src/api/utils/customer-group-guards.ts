import type {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  PARTNER_RATE_KEY,
  resolveGroupPolicyForCustomer,
  VERIFICATION_EXEMPT_KEY,
  WITHDRAWALS_BLOCKED_KEY,
} from '../../modules/packs/group-policy';

const GROUP_POLICY_KEYS = [
  PARTNER_RATE_KEY,
  WITHDRAWALS_BLOCKED_KEY,
  VERIFICATION_EXEMPT_KEY,
] as const;

/**
 * POST /admin/customer-groups and POST /admin/customer-groups/:id — drop
 * `additional_data` from the body before core's validator sees it.
 *
 * Why: the prebuilt @mercurjs/admin Edit Customer Group form is built on the
 * dashboard's useExtendableForm, which always submits `additional_data` (an
 * empty object when no form extension is registered). Core Medusa 2.19's
 * AdminUpdateCustomerGroup is a strict zod object with no such field
 * (@medusajs/medusa dist/api/admin/customer-groups/validators.js), so EVERY
 * rename 400s with "Unrecognized fields: 'additional_data'". Nothing on the
 * backend consumes the field (the route has no additionalDataValidator), so
 * stripping it loses nothing.
 *
 * Ordering: core's api dir is scanned BEFORE the project's, and the sorter
 * keeps insertion order within a bucket — so this must be registered on a
 * matcher that sorts into an EARLIER bucket than core's entries. See the
 * '/admin/customer-groups*' entry in middlewares.ts for the exact trick.
 *
 * Removes the key only — everything else in the body reaches the validator
 * untouched, so an actually-invalid rename still fails the way it should.
 */
export function stripAdditionalData(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const body = req.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === 'object' && 'additional_data' in body) {
    delete body.additional_data;
  }
  next();
}

export const GROUP_POLICY_METADATA_MESSAGE =
  'partner_rate_bp, withdrawals_blocked and verification_exempt are set through POST /admin/customer-groups/:id/policy, which checks the rate against the partner bounds and records the change.';

/**
 * Same matcher as stripAdditionalData: refuse a body whose `metadata` carries
 * any partner-policy key. The native create/update routes merge arbitrary
 * metadata with no bounds check and no audit row (the prebuilt dashboard's
 * Metadata editor reaches them too), so without this a
 * `metadata: { partner_rate_bp: 10000 }` would pay a group at 100% with
 * nothing in the audit trail. The repo's /policy route is the only writer;
 * `odds_set` and the DEFAULT marker still pass. Same shape as
 * rejectAdminBankAccountsMetadata (customer-metadata-guard.ts).
 */
export function rejectGroupPolicyMetadata(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const body = req.body as Record<string, unknown> | null | undefined;
  const metadata = body?.metadata as Record<string, unknown> | null | undefined;
  if (
    metadata &&
    typeof metadata === 'object' &&
    GROUP_POLICY_KEYS.some((key) => key in metadata)
  ) {
    next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        GROUP_POLICY_METADATA_MESSAGE,
      ),
    );
    return;
  }
  next();
}

export const WITHDRAWALS_BLOCKED_MESSAGE =
  'Withdrawals are not available on this account.';

/**
 * POST /store/credits/withdraw — a member of a player group whose policy has
 * `withdrawals_blocked` cannot start a bank withdrawal (spec 2026-09-09).
 *
 * Fails CLOSED: a read failure on the group lookup is handed to next(e) and
 * becomes a 500, never a free pass on a money-out path (same rule as
 * requirePhoneVerified). Register-token bearers (actor_id '') are refused as
 * unauthenticated, as the route itself would.
 */
export const blockGroupWithdrawals = async (
  req: AuthenticatedMedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> => {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    return next(
      new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized'),
    );
  }
  let blocked: boolean;
  try {
    const resolved = await resolveGroupPolicyForCustomer(req.scope, customerId);
    blocked = resolved?.policy.withdrawals_blocked === true;
  } catch (e) {
    return next(e as Error);
  }
  if (blocked) {
    return next(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        WITHDRAWALS_BLOCKED_MESSAGE,
      ),
    );
  }
  next();
};

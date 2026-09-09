import type {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { resolveGroupPolicyForCustomer } from '../../modules/packs/group-policy';

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
 * Ordering: the framework's ApiLoader scans the project api dir BEFORE core's
 * and its sorter keeps insertion order within a bucket, so a project
 * middleware on the same matcher runs ahead of core's validateAndTransformBody
 * (verified in @medusajs/framework dist/http/router.js + routes-sorter.js).
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

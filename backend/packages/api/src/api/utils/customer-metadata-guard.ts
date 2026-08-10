import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';

// Medusa's stock update-customer route accepts arbitrary `metadata` — read from
// the installed package, not assumed:
// node_modules/@medusajs/medusa/dist/api/store/customers/validators.js declares
// StoreUpdateCustomer with `metadata: z.record(z.unknown()).nullish()`, and
// .../customers/me/route.js passes req.validatedBody into
// updateCustomersWorkflow. Nothing upstream of this middleware refuses it.
//
// THIS IS A MONEY CONTROL. It was written as a cosmetic one — avatar_url and
// equipped_frame_level (written ONLY by /store/profile/avatar|frame, plus the
// backend-assigned handle), where a client-supplied blob bought you a locked
// frame or an arbitrary avatar URL. Plan 088 moved saved payout bank accounts
// into the SAME blob (customer.metadata.bank_accounts) and made that list the
// enforcement point for where a withdrawal may go. So this guard is now the
// only thing between a stolen customer bearer token and an arbitrary payout
// destination: without it, one POST /store/customers/me plants a bank account
// with a backdated `savedAt` (clearing the cooling-off window, and the
// add-a-destination email notice never fires), and the next
// POST /store/credits/withdraw pays out to it.
//
// Coverage lives in integration-tests/http/customer-metadata-guard.spec.ts,
// which asserts the 400 AND this exact message on both wired routes — unwire
// either middlewares.ts entry (:405, :419) and it goes red.
//
// Reject the whole field — fail-closed for future reserved keys; the storefront
// never sends metadata on profile updates.
export function rejectCustomerMetadata(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const body = req.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === 'object' && 'metadata' in body) {
    next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'metadata is not updatable on this route.',
      ),
    );
    return;
  }
  next();
}

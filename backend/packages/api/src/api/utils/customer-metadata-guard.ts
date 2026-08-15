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

/**
 * Admin-side counterpart: refuse a bank_accounts write through the framework's
 * generic customer route.
 *
 * Narrower than rejectCustomerMetadata on purpose. The store guard rejects the
 * whole metadata field because the storefront never sends it; an operator may
 * legitimately need to fix another key (a handle, say), so only the reserved
 * payout-destination key is refused here.
 *
 * Why it matters: mergeMetadata is a shallow top-level merge, so
 * metadata:{bank_accounts:[...]} INJECTS the key while siblings survive, and
 * the saved-account id is sha256(bankCode, accountNumber) with no server secret
 * — offline-computable, so a well-formed entry passes resolveWithdrawalDestination's
 * integrity re-check. That write would bypass both the metadata:<customer>
 * advisory lock and any audit row, unlike setPayoutDetails which records bank
 * name + last-4 on every change.
 */
export function rejectAdminBankAccountsMetadata(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const body = req.body as Record<string, unknown> | null | undefined;
  const metadata = body?.metadata as Record<string, unknown> | null | undefined;
  if (metadata && typeof metadata === 'object' && 'bank_accounts' in metadata) {
    next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'bank_accounts is not writable through this route. Payout destinations are customer-owned and audited.',
      ),
    );
    return;
  }
  next();
}

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { hasPermission } from '@medusajs/framework';
import { PARTNER_CREDENTIAL_KEY } from '../../utils/partner-accounts';

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

// customer.metadata keys only a role with their own read policy may receive.
const SECRET_METADATA = [
  { key: 'bank_accounts', resource: 'customer_bank_account' },
  { key: PARTNER_CREDENTIAL_KEY, resource: 'partner_credential' },
] as const;

/** Removes the keys from every `metadata`, at any depth. */
const stripSecretMetadata = (node: unknown, hidden: string[]): void => {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'metadata' && value && typeof value === 'object') {
      for (const secret of hidden)
        delete (value as Record<string, unknown>)[secret];
    } else {
      stripSecretMetadata(value, hidden);
    }
  }
};

/**
 * Any admin response can carry customer.metadata whole: `?fields=` walks
 * relations (an order's customer, a group's customers) and writes echo the
 * record. That blob holds full bank account numbers and partner account
 * passwords. SECRET_READS (api/admin-rbac.ts) fences the routes built to serve
 * them, so without this any role read the same values here, in bulk and with no
 * audit row. Same policies, same answer.
 */
export async function redactCustomerSecrets(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  try {
    const roles =
      (
        req as unknown as {
          auth_context?: { app_metadata?: { roles?: string[] } };
        }
      ).auth_context?.app_metadata?.roles ?? [];
    const hidden: string[] = [];
    for (const { key, resource } of SECRET_METADATA) {
      // hasPermission answers true for an empty role list: never here.
      const allowed =
        roles.length > 0 &&
        (await hasPermission({
          roles,
          actions: { resource, operation: 'read' },
          container: req.scope,
        }));
      if (!allowed) hidden.push(key);
    }
    if (hidden.length > 0) {
      const json = res.json.bind(res);
      // A copy, so a cached object can never lose its keys for the next caller.
      res.json = (body: unknown) => {
        const copy = JSON.parse(JSON.stringify(body ?? null));
        stripSecretMetadata(copy, hidden);
        return json(copy);
      };
    }
    next();
  } catch (e) {
    // Fail closed: no check, no response.
    next(e);
  }
}

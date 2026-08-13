'use server';

/**
 * Customer self-service account deletion.
 *
 * Backend route (authenticated as the caller, no id is ever passed):
 *   POST /store/customers/me/delete → { deleted: true }
 *
 * Disabling an account is an ADMIN action and lives in the admin dashboard —
 * there is deliberately no customer-facing disable or reactivate here.
 *
 * Server actions return errors, they never throw — a thrown action surfaces as
 * an error page, and every failure here has to render inside the modal that
 * triggered it.
 *
 * The link map lives in `./account-lifecycle-map` because this file is
 * `'use server'` and may only export async functions.
 */

import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { clearAuthToken, getAuthToken } from '@/lib/data/customer';
import { GENERIC_ERROR } from './account-lifecycle-map';

export type DeleteResult =
  { ok: true } | { ok: false; error: string; reason: string | null };

/** Re-exported shape: the sentence itself lives in the client-safe map so the
 *  UI can show the same copy on a rejected action. */
const GENERIC = GENERIC_ERROR;
const LOGGED_OUT = 'Please log in first.';

/**
 * Backend delete-refusal codes → the sentence the modal shows. These are CODES,
 * not prose, precisely so this mapping is exact rather than a regex over human
 * copy that changes.
 *
 * The backend sends the code as the error MESSAGE, not as a separate field:
 * Medusa's error handler serializes only { code, type, message }, so an
 * `err.detail` would be dropped on the way out. The numbers behind each refusal
 * stay server-side in the log line, where support can find them.
 *
 * Six of these mirror `DeleteBlockReason` (the settlement preflight); the two
 * password codes are thrown separately by the delete route's proof-of-intent
 * step and are NOT part of that union — don't let the backend type talk you
 * down to six.
 */
const DELETE_COPY: Record<string, string> = {
  PASSWORD_REQUIRED: 'Enter your password to confirm.',
  PASSWORD_INCORRECT: 'That password is incorrect.',
  // Orthogonal to `disabled`, so it arrives on a perfectly healthy session.
  // Only support can lift it.
  ACCOUNT_FROZEN: 'This account is under review. Please contact support.',
  // Deliberately NOT "withdraw your balance and try again". The playthrough
  // gate locks a deposit that was never spent on a pack, so a customer who
  // deposited and never opened anything CANNOT withdraw — that instruction
  // would send them in a circle. Refusing is still right (deleting would strand
  // the money), so the copy offers support as the other exit.
  BALANCE_NOT_ZERO:
    'Your wallet still holds a balance. Withdraw it first — or contact support if it cannot be withdrawn yet.',
  WITHDRAWAL_PENDING:
    'A withdrawal is still processing. Try again once it completes.',
  DEPOSIT_PENDING:
    'A deposit is still processing. Try again once it completes.',
  CARDS_UNSETTLED:
    'Your vault still has cards. Sell or ship them before deleting.',
  DELIVERY_IN_FLIGHT:
    'A delivery is still on its way. Try again once it arrives.',
};

/**
 * Pull a known refusal code out of a failed request.
 *
 * The whole map rests on the SDK preserving the backend's message, so: on a
 * non-2xx `@medusajs/js-sdk` throws `FetchError extends Error` with
 * `super(jsonError.message ?? resp.statusText)` (client.js normalizeResponse).
 * `message` is the field Medusa's error handler serializes, and the delete
 * route constructs MedusaError with the bare code — so `error.message` arrives
 * as exactly `BALANCE_NOT_ZERO`, unprefixed.
 *
 * Substring rather than equality anyway, so a future status prefix wouldn't
 * silently break every refusal. No code is a substring of another, so the scan
 * stays unambiguous. Anything else — a network drop, a non-JSON body (message
 * falls back to statusText), or a refusal code added to the backend after this
 * map was written — yields null and the caller falls back to GENERIC rather
 * than a blank refusal.
 */
const codeOf = (
  error: unknown,
  copy: Record<string, string>,
): string | null => {
  const text = error instanceof Error ? error.message : String(error);
  for (const code of Object.keys(copy)) {
    if (text.includes(code)) return code;
  }
  return null;
};

/**
 * Delete the caller's own account, permanently. `password` is null for a
 * Google-only account, where the backend skips the password check entirely.
 */
export async function deleteAccount(
  password: string | null,
): Promise<DeleteResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: LOGGED_OUT, reason: null };
  try {
    await sdk.client.fetch('/store/customers/me/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: password === null ? {} : { password },
    });
  } catch (error) {
    logger.error('[account] delete failed:', error);
    const reason = codeOf(error, DELETE_COPY);
    // `?? GENERIC` is load-bearing twice: noUncheckedIndexedAccess types the
    // lookup as possibly-undefined, and it guarantees a future code can never
    // render an empty refusal.
    return {
      ok: false,
      reason,
      error: (reason ? DELETE_COPY[reason] : GENERIC) ?? GENERIC,
    };
  }
  // Only after a confirmed success — a failed delete leaves the account alive,
  // and the customer needs to stay logged in to see why it refused.
  await clearAuthToken();
  return { ok: true };
}

'use server';

/**
 * Customer self-service account lifecycle — disable, reactivate, delete.
 *
 * Backend routes (all authenticated as the caller, no id is ever passed):
 *   POST /store/customers/me/disable    → { disabled: true }
 *   POST /store/customers/me/reactivate → { disabled: false }
 *   POST /store/customers/me/delete     → { deleted: true }
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
import { ACCOUNT_SELF_DISABLED } from './account-lifecycle-map';

export type LifecycleResult = { ok: true } | { ok: false; error: string };
export type DeleteResult =
  | { ok: true }
  | { ok: false; error: string; reason: string | null };
/** Disable carries a refusal code too — same shape, different codes. */
export type DisableResult = DeleteResult;

const GENERIC = 'Something went wrong. Please try again.';
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
 * The one refusal DISABLE can hit that is not a failure at all: the account is
 * already disabled.
 *
 * Newly reachable, and the reason this map exists. The session guard's
 * self-disable carve-out admits the account layout's customer read, so
 * /settings renders for a self-disabled customer and the Danger zone's Disable
 * button is live — but /disable is NOT in that carve-out, so pressing it 403s.
 * Unmapped, that fell through to GENERIC and the modal said "Something went
 * wrong. Please try again." Nothing went wrong, retrying cannot help, and the
 * account the customer is being asked to disable is already disabled.
 */
const DISABLE_COPY: Record<string, string> = {
  [ACCOUNT_SELF_DISABLED]:
    'Your account is already disabled. Log out, then log back in to reactivate it.',
};

/** Disable the caller's own account, then drop the session cookie. */
export async function disableAccount(): Promise<DisableResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: LOGGED_OUT, reason: null };
  try {
    await sdk.client.fetch('/store/customers/me/disable', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    logger.error('[account] disable failed:', error);
    // Cookie deliberately untouched: a customer whose disable failed is still
    // active, and logging them out would hide that from them. (That reasoning
    // holds for ACCOUNT_SELF_DISABLED too — clearing the cookie there would
    // sign out someone whose session is still the only way to reach delete.)
    const reason = codeOf(error, DISABLE_COPY);
    return {
      ok: false,
      reason,
      error: (reason ? DISABLE_COPY[reason] : GENERIC) ?? GENERIC,
    };
  }
  await clearAuthToken();
  return { ok: true };
}

/**
 * Lift the caller's own disable. The session cookie stays — they continue in.
 *
 * The backend answers 200 without writing when the account is not disabled at
 * all (an admin can re-enable between the login attempt and this confirm), so
 * the response body is not inspected: any 200 is success.
 */
export async function reactivateAccount(): Promise<LifecycleResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: LOGGED_OUT };
  try {
    await sdk.client.fetch('/store/customers/me/reactivate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: true };
  } catch (error) {
    logger.error('[account] reactivate failed:', error);
    return { ok: false, error: GENERIC };
  }
}

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

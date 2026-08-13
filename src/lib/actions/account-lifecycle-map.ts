/**
 * The client-safe half of the account-lifecycle contract: the blocker link map
 * and the delete confirmation gate.
 *
 * Where the customer has to go to clear each delete blocker.
 *
 * A plain module, deliberately NOT part of `account-lifecycle.ts`: that file
 * carries `'use server'`, and a `'use server'` module may only export async
 * functions — a runtime object export there fails the build. Same split the
 * repo already uses for `vault-map.ts` / `vip-map.ts` beside their actions, and
 * it keeps a client component from reaching into a server-actions file for a
 * constant.
 *
 * An instruction without a route is a dead end — every reason here is something
 * the customer can only fix on another page. The password codes
 * (PASSWORD_REQUIRED, PASSWORD_INCORRECT) are fixed in the modal itself, so
 * they have no entry and the UI renders copy alone.
 *
 * Keys mirror the backend's `DeleteBlockReason`, which lives in the backend
 * package and cannot be imported across the boundary. The duplication is
 * deliberate; the test pins the key set, and the copy map has a fallback so an
 * unmapped future code still renders something.
 */
export const DELETE_LINK: Record<string, { href: string; label: string }> = {
  // Only support can lift a freeze — it is a live hold on the account, not
  // something the customer can clear themselves on any storefront page.
  // /contact is chat-only (Instagram/Facebook) by design; there is no ticket
  // form or support email to point at instead.
  ACCOUNT_FROZEN: { href: '/contact', label: 'Contact support' },
  BALANCE_NOT_ZERO: { href: '/wallet', label: 'Go to wallet' },
  WITHDRAWAL_PENDING: { href: '/transactions', label: 'View withdrawals' },
  DEPOSIT_PENDING: { href: '/transactions', label: 'View deposits' },
  CARDS_UNSETTLED: { href: '/vault', label: 'Open vault' },
  DELIVERY_IN_FLIGHT: { href: '/orders', label: 'Track delivery' },
};

/**
 * The backend's `SELF_DISABLED_CODE`, duplicated across the package boundary
 * (same reason as the keys above — the backend package cannot be imported).
 *
 * Reachable on DISABLE since the session guard began admitting the account
 * layout's customer read: /settings now renders for a self-disabled customer,
 * so the Danger zone's Disable button is live for someone who is already
 * disabled. /disable is NOT in the carve-out, so it answers 403 with this code.
 */
export const ACCOUNT_SELF_DISABLED = 'ACCOUNT_SELF_DISABLED';

/** The word the customer must type to arm the permanent delete. */
export const CONFIRM_WORD = 'DELETE';

/**
 * Whether the Delete button may be armed. Lives here rather than inline in
 * DangerZone.tsx so it can be tested: vitest collects `src/**\/*.test.ts` only,
 * so a predicate inside a `.tsx` is silently uncoverable.
 *
 * It is worth testing because the confirm word is the ONLY thing standing
 * between a Google-only account and irreversible deletion — that account sends
 * no password, so the backend has no proof-of-intent step to fall back on and
 * accepts the request on the session alone. For a password account this gate is
 * belt-and-braces (the backend re-checks); for a Google one it is the whole
 * belt. Inverting either half of the `&&` would arm the button on an empty form.
 *
 * The typed word is trimmed but NOT case-folded: trailing whitespace from a
 * paste or a mobile keyboard is invisible, and leaving the button dead with no
 * explanation is a support ticket, whereas lowercase `delete` is a visible
 * mismatch the customer can see and fix. The capitals are the deliberate
 * friction; the whitespace never was.
 */
export function deleteConfirmReady(input: {
  hasPassword: boolean;
  password: string;
  confirmWord: string;
}): boolean {
  if (input.confirmWord.trim() !== CONFIRM_WORD) return false;
  return !input.hasPassword || input.password.length > 0;
}

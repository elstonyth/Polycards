/**
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

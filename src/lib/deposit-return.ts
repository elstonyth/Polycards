/**
 * "A deposit is in flight" — the one bit of state that survives the trip to the
 * payment gateway and back.
 *
 * WHY it exists: paying is a FULL navigation away from the site (TopUpSheet's
 * `leaveFor`, deliberately not a popup), so nothing of ours runs while the
 * customer scans the QR in their banking app. They come back to /transactions
 * as a cold page load, and the credit may still be seconds away — the gateway
 * is not delivering deposit callbacks, so crediting happens on the backend's
 * one-minute reconcile sweep. Without this flag that page renders the old
 * balance and then sits there, which reads as "I paid and nothing happened".
 *
 * sessionStorage, not a cookie or a query param: it must not survive the tab,
 * must not be forgeable into a server request, and the gateway controls the
 * return URL so we cannot put anything on it ourselves.
 */
const KEY = 'polycards:deposit-in-flight';

/**
 * How long the flag stays meaningful. Their cashier times out in 10 minutes; a
 * customer who abandoned the payment and wandered back an hour later must not
 * make the page poll for nothing.
 */
export const DEPOSIT_IN_FLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

/** Called just before we hand the tab to the gateway. */
export function markDepositInFlight(now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // Private mode / storage disabled: the customer just refreshes. Never let
    // a storage quirk break the payment itself.
  }
}

/**
 * Read-and-clear. Consuming means a second mount (a back-nav, a page-size
 * change) does not start polling all over again — one return trip, one poll
 * window.
 */
export function takeDepositInFlight(now = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return false;
    sessionStorage.removeItem(KEY);
    const started = Number(raw);
    return (
      Number.isFinite(started) && now - started < DEPOSIT_IN_FLIGHT_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

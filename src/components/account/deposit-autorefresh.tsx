'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { takeDepositInFlight } from '@/lib/deposit-return';

/** Gap between refreshes. The backend sweep runs every minute, so anything
 *  tighter just re-renders the same numbers. */
const EVERY_MS = 5_000;

/** How long to keep watching. Covers the worst case of the one-minute sweep
 *  cadence plus the requery round-trip, then stops rather than polling a page
 *  someone left open. */
const WINDOW_MS = 90_000;

/**
 * Re-reads /transactions for a bounded window after the customer returns from
 * the payment gateway.
 *
 * Mounted on the page the gateway's ReturnUrl points at, and it only runs when
 * `takeDepositInFlight()` says this visit IS that return trip — an ordinary
 * visit to /transactions costs nothing.
 *
 * `router.refresh()` re-runs the server component, so the balance, the stat
 * cards and the ledger rows all land together, from the same read. It leaves
 * history untouched (unlike revalidatePath, which clobbers the back stack).
 */
export function DepositAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    if (!takeDepositInFlight()) return;

    const stopAt = Date.now() + WINDOW_MS;
    const id = setInterval(() => {
      if (Date.now() >= stopAt) {
        clearInterval(id);
        return;
      }
      router.refresh();
    }, EVERY_MS);

    return () => clearInterval(id);
    // Once per mount: the flag is consumed on the first run, so a re-run would
    // be a no-op anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

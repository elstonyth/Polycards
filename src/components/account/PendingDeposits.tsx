'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { rm } from '@/lib/format';
import { gatewayMethodLabel } from '@/lib/transactions';
import type { PendingDeposit } from '@/lib/actions/vault';

/** How often to re-ask the server while a payment is confirming. The deposit
 *  sweep runs every minute and the gateway callback lands sooner than that, so
 *  ten seconds is fast enough that the row disappears within a breath of the
 *  credit landing, and slow enough to be nothing next to a page view. */
const POLL_MS = 10_000;

/**
 * "Confirming your payment…" — the in-flight top-ups the ledger cannot show.
 *
 * The Transactions page reads the credit ledger, and a deposit writes nothing
 * there until it settles. So a customer who paid and came straight back saw no
 * trace of their money and concluded the payment had failed. This is the trace.
 *
 * Every time-derived string arrives PRE-COMPUTED from getPendingDeposits: this
 * renders on the server and again on hydration, so a clock read in either pass
 * would make the two disagree. The refresh below is what advances them.
 *
 * Client-only for that refresh — router.refresh() re-runs the server component,
 * and when the credit lands the deposit is no longer pending, the list comes
 * back empty, and this unmounts (which is also what stops the interval).
 */
export function PendingDeposits({ deposits }: { deposits: PendingDeposit[] }) {
  const router = useRouter();
  const outstanding = deposits.length;

  useEffect(() => {
    if (outstanding === 0) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [outstanding, router]);

  if (outstanding === 0) return null;

  return (
    <div className="mt-5 space-y-2">
      {deposits.map((deposit) => (
        <div
          key={deposit.reference}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
          // Polite, not assertive: a payment landing is good news, not an
          // interruption worth cutting across whatever is being read.
          aria-live="polite"
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-buyback-fg"
          />
          <span className="text-sm font-semibold text-white">
            {deposit.overdue
              ? `Still waiting on ${rm(deposit.amount)}`
              : `Confirming your ${rm(deposit.amount)} top-up…`}
          </span>
          <span className="text-[13px] text-white/50">
            {deposit.method ? `${gatewayMethodLabel(deposit.method)} · ` : ''}
            started {deposit.startedLabel} · awaiting gateway
          </span>
          <span className="ml-auto font-mono text-[12px] break-all text-white/40">
            {deposit.reference}
          </span>
          <p className="w-full text-[13px] text-white/50">
            {deposit.overdue
              ? 'This is taking longer than usual. Your payment is not lost — quote the reference above to support.'
              : 'Credit lands automatically the moment the payment clears. You can leave this page.'}
          </p>
        </div>
      ))}
    </div>
  );
}

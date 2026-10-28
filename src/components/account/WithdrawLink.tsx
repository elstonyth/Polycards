'use client';

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { getPaymentLimits } from '@/lib/actions/vault';
import { reopenLabel } from '@/lib/reopen-time';
import { useModalA11y } from '@/lib/use-modal-a11y';

/**
 * The Withdraw button. While the admin has withdrawals closed (switched off,
 * inside the daily closed hours, or a timed pause), a tap opens a popup
 * saying so, and when they reopen, instead of the form. UX only: POST /store/credits/withdraw
 * refuses on its own, and /bank-withdrawal shows the same closed state to
 * anyone who lands there directly.
 */
export function WithdrawLink({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<{ until: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  useModalA11y(panelRef, open, () => setOpen(false));

  useEffect(() => {
    let cancelled = false;
    getPaymentLimits()
      .then((l) => {
        if (!cancelled && l.withdrawalsUnavailable)
          setClosed({ until: l.withdrawalsPausedUntil ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // A closed window that has since ended lets the tap through.
    if (!closed || (closed.until && Date.parse(closed.until) <= Date.now()))
      return;
    e.preventDefault();
    setOpen(true);
  }

  const reopen = closed?.until ? reopenLabel(closed.until) : null;

  return (
    <>
      <Link href="/bank-withdrawal" onClick={onClick} className={className}>
        {children}
      </Link>
      {open &&
        // Portalled like AnnouncementPopup, so no ancestor's stacking context
        // traps it under the header, tab bar or cookie banner.
        createPortal(
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
            {/* Backdrop: mouse/touch close only; OK and Escape cover the rest. */}
            <button
              type="button"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="glass-scrim glass-stage absolute inset-0 cursor-default motion-safe:animate-[fadeIn_0.2s_ease-out]"
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="withdraw-unavailable-title"
              aria-describedby="withdraw-unavailable-body"
              tabIndex={-1}
              className="glass-panel relative z-10 w-full max-w-sm rounded-2xl border p-6 outline-none motion-safe:animate-[modalIn_0.25s_ease-out] sm:p-7"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
                <Wrench className="h-5 w-5 text-white" aria-hidden />
              </span>
              <h2
                id="withdraw-unavailable-title"
                className="font-heading mt-4 text-2xl text-white"
              >
                Withdrawals unavailable
              </h2>
              <p
                id="withdraw-unavailable-body"
                className="mt-2 text-sm leading-relaxed text-neutral-400"
              >
                {reopen
                  ? `Withdrawals are paused for maintenance until ${reopen} (Malaysia time). Your balance is safe — please try again then.`
                  : 'Withdrawals are paused for maintenance right now. Your balance is safe — please try again later.'}
              </p>
              <Pill className="mt-6 w-full" onClick={() => setOpen(false)}>
                OK
              </Pill>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

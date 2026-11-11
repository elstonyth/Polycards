'use client';

import { useEffect, useState } from 'react';
import { Send, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useConsent } from '@/lib/use-consent';
import { useAuth } from '@/components/auth/AuthProvider';
import { TELEGRAM_URL } from '@/lib/site';

const DISMISSED_KEY = 'polycards.telegram-banner-session-dismissed';
// The stored value names who dismissed: a customer id, or this for a guest.
const GUEST = 'guest';

/**
 * Community link shares the floating rail with the welcome-pack badge.
 *
 * A matte chip since 2026-11-11 (home critique): the neon ticket art read as
 * the cheap-gacha look PRODUCT.md rules out, and guests could not close it.
 * Everyone can now dismiss it for the visit. Home shows no floating rail at
 * all (it would sit on the pack ladder's prices); the footer carries the link.
 */
export function TelegramBanner() {
  const pathname = usePathname();
  const consent = useConsent();
  const { customer, isLoading } = useAuth();
  const customerId = customer?.id ?? null;
  const [session, setSession] = useState<{
    customerId: string | null;
    dismissed: boolean;
  } | null>(null);

  useEffect(() => {
    if (isLoading) return;
    const sync = () => {
      let dismissed = false;
      try {
        const stored = sessionStorage.getItem(DISMISSED_KEY);
        // An observed logout ends a customer's dismissal, including on routes
        // where this banner is hidden. Reloads within the same login retain it.
        if (!customerId && stored !== null && stored !== GUEST) {
          sessionStorage.removeItem(DISMISSED_KEY);
        } else {
          dismissed = stored === (customerId ?? GUEST);
        }
      } catch {
        // Storage may be unavailable; in-memory dismissal still works.
      }
      setSession({ customerId, dismissed });
    };
    sync();
  }, [customerId, isLoading]);

  const dismiss = () => {
    setSession({ customerId, dismissed: true });
    try {
      sessionStorage.setItem(DISMISSED_KEY, customerId ?? GUEST);
    } catch {
      // Still dismiss for this visit when browser storage is unavailable.
    }
  };

  // These routes own purchase, reveal, sell, or challenge controls, and home
  // owns its price column. Cookie consent also owns this rail until the
  // visitor has made a choice.
  if (
    isLoading ||
    !session ||
    session.customerId !== customerId ||
    session.dismissed ||
    consent === null ||
    pathname === '/' ||
    pathname.startsWith('/slots/') ||
    pathname === '/vault' ||
    pathname.startsWith('/vault/') ||
    pathname === '/leaderboard' ||
    pathname === '/lucky-draw'
  ) {
    return null;
  }

  return (
    <div
      data-telegram-banner
      className="glass-chrome fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 flex h-11 items-center rounded-full border border-white/15 lg:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]"
    >
      <a
        href={TELEGRAM_URL}
        aria-label="Join our Telegram community"
        className="flex h-full items-center gap-2 rounded-full pr-1 pl-4 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
      >
        <Send className="size-4" aria-hidden="true" />
        Telegram
      </a>
      <button
        type="button"
        aria-label="Dismiss Telegram banner"
        onClick={dismiss}
        className="flex size-11 items-center justify-center rounded-full text-neutral-400 transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none motion-reduce:transition-none"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

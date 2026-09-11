'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useConsent } from '@/lib/use-consent';
import { useAuth } from '@/components/auth/AuthProvider';

const DISMISSED_KEY = 'polycards.telegram-banner-session-dismissed';

/** Community link shares the floating rail with the welcome-pack badge. */
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
        // An observed logout ends the dismissal, including on routes where
        // this banner is hidden. Reloads within the same login retain it.
        if (!customerId) sessionStorage.removeItem(DISMISSED_KEY);
        else dismissed = sessionStorage.getItem(DISMISSED_KEY) === customerId;
      } catch {
        // Storage may be unavailable; in-memory dismissal still works.
      }
      setSession({ customerId, dismissed });
    };
    sync();
  }, [customerId, isLoading]);

  const dismiss = () => {
    if (!customerId) return;
    setSession({ customerId, dismissed: true });
    try {
      sessionStorage.setItem(DISMISSED_KEY, customerId);
    } catch {
      // Still dismiss for this visit when browser storage is unavailable.
    }
  };

  // These routes own purchase, reveal, sell, or challenge controls. Cookie
  // consent also owns this rail until the visitor has made a choice.
  if (
    isLoading ||
    !session ||
    session.customerId !== customerId ||
    (customerId !== null && session.dismissed) ||
    consent === null ||
    pathname.startsWith('/slots/') ||
    pathname === '/vault' ||
    pathname === '/leaderboard'
  ) {
    return null;
  }

  return (
    <div
      data-telegram-banner
      className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 w-[clamp(10rem,40vw,15rem)] lg:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]"
    >
      <a
        href="https://t.me/polycardsgg"
        aria-label="Join our Telegram community"
        className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Image
          src="/images/polycards/telegram-community-ticket.webp"
          alt="Join our Telegram community — Join now"
          width={864}
          height={393}
          sizes="(max-width: 400px) 160px, (max-width: 600px) 40vw, 240px"
          className="block h-auto w-full [mask-image:url('/images/polycards/telegram-ticket-mask.svg')] [mask-size:100%_100%]"
        />
      </a>
      {customerId && (
        <button
          type="button"
          aria-label="Dismiss Telegram banner"
          onClick={dismiss}
          className="absolute -top-6 -right-2 flex size-11 items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-white"
        >
          <span className="flex size-6 items-center justify-center rounded-full border border-white/30 bg-neutral-900">
            <X size={14} aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
}

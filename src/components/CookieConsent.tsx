'use client';

import { useEffect, useState } from 'react';
import { getConsent, setConsent } from '@/lib/consent';

export default function CookieConsent() {
  const [show, setShow] = useState(false);

  // Read after mount so SSR markup matches and we don't flash the banner for
  // users who already chose. Intentional post-mount sync read (same pattern as
  // the other deliberate effect reads in this app).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setShow(getConsent() === null), []);

  if (!show) return null;

  const choose = (state: 'accepted' | 'rejected') => {
    setConsent(state);
    setShow(false);
  };

  // TabBar's real height is 4rem + safe-area inset (TabBar.tsx), so a plain
  // bottom-16 would overlap the tab icons on notch devices.
  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-50 border-t border-neutral-800 bg-neutral-900/95 px-4 py-4 backdrop-blur lg:bottom-0 lg:pb-[calc(1rem+env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
        <p className="text-sm text-neutral-300">
          We use cookies to keep you signed in and improve the experience. See
          our{' '}
          <a
            href="https://docs.polycards.com/user-agreements/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white"
          >
            Privacy Policy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => choose('rejected')}
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-neutral-300 hover:text-white"
          >
            Reject
          </button>
          <button
            onClick={() => choose('accepted')}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}

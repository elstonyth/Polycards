'use client';

import { useEffect, useState } from 'react';
import { CONSENT_EVENT, getConsent, setConsent } from '@/lib/consent';

// Withdrawal path for the cookie banner's choice (CookieConsent.tsx only
// shows once, on first visit, so accepting there is otherwise a one-way
// door for a year — see storage max-age in consent.ts).
export default function CookieSettings() {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const sync = () => setAccepted(getConsent() === 'accepted');
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, []);

  function choose(next: 'accepted' | 'rejected') {
    const wasAccepted = accepted;
    setConsent(next);
    // The already-injected `fbq` global (and its fbevents.js script tag)
    // cannot be un-injected — only a reload guarantees the pixel stops
    // firing. Only needed on the accepted → rejected transition; MetaPixel
    // itself listens on CONSENT_EVENT, so accepting needs no reload.
    if (next === 'rejected' && wasAccepted) {
      window.location.reload();
      return;
    }
    setAccepted(next === 'accepted');
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-white">Analytics cookies</p>
        <p className="text-[12px] text-white/55">
          {accepted ? 'Currently allowed.' : 'Currently blocked.'}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={() => choose('rejected')}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-white/10 px-3 text-sm font-medium text-neutral-300 hover:text-white"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => choose('accepted')}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
        >
          Allow
        </button>
      </div>
    </div>
  );
}

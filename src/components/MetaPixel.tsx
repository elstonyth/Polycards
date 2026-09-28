'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CONSENT_EVENT, getConsent, type ConsentState } from '@/lib/consent';
import { PIXEL_ENABLED, pixelSnippet, syncConsent } from '@/lib/pixel';

const META_PIXEL_ID = '1829134618519800';

// Routes that carry a single-use credential in the URL (query string or
// path). The pixel's PageView beacon reports the full URL to Facebook, and
// that race is independent of how fast the page scrubs the query client-side
// — so these routes never get a pixel, full stop. Add a route here the
// moment it puts a token/secret in the URL.
//
// Recorded acceptance: once fbevents.js has loaded on a prior page, its own
// pushState auto-tracking can still beacon a CLIENT-SIDE navigation onto a
// tokenized route — the guard below re-runs on every pathname change and
// returns null on the tokenized route, unmounting the <Script>, but that
// cannot unload the already-fetched fbevents.js global or its pushState
// hook. Accepted — the threat model this guards is the email-link direct
// load, which this null-return fully covers.
const TOKENIZED_ROUTES = ['/reset-password'];

// Loads the Meta Pixel only after the visitor accepts the cookie banner
// (CookieConsent.tsx), and only in production builds (PIXEL_ENABLED). Mounting
// after a mid-session "Accept" fires the deferred init + PageView and runs
// what lib/pixel.ts held for it; the pixel itself auto-tracks App Router
// client-side navigations via history.pushState.
export default function MetaPixel() {
  const pathname = usePathname();
  const [consent, setConsent] = useState<ConsentState | null>(null);

  useEffect(() => {
    const sync = () => setConsent(getConsent());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    // An answer given in another tab counts here too — otherwise this tab
    // keeps holding events for a pixel it never loads.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // A sign-up waiting on the banner, or landed here through the Google
  // redirect, is sent once the pixel may send; a "no" drops what was held.
  useEffect(() => {
    syncConsent();
    // fbevents.js cannot be unloaded: a "no" that arrives after it loaded in
    // this page (another tab's banner, a stale one here) needs a fresh page,
    // or its own history tracking keeps reporting navigations.
    if (consent === 'rejected' && window.fbq) window.location.reload();
  }, [consent]);

  if (!PIXEL_ENABLED) return null;
  // Checked before consent: a visitor who lands directly on a tokenized route
  // must get no pixel for that page, even if they'd already consented.
  if (TOKENIZED_ROUTES.includes(pathname)) return null;
  if (consent !== 'accepted') return null;

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {pixelSnippet(META_PIXEL_ID)}
    </Script>
  );
}

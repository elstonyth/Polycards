'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CONSENT_EVENT, getConsent } from '@/lib/consent';

const META_PIXEL_ID = '956101387505207';

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
// (CookieConsent.tsx). Mounting after a mid-session "Accept" fires the
// deferred init + PageView; the pixel itself auto-tracks App Router
// client-side navigations via history.pushState.
export default function MetaPixel() {
  const pathname = usePathname();
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    const sync = () => setConsented(getConsent() === 'accepted');
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, []);

  // Checked before consent: a visitor who lands directly on a tokenized route
  // must get no pixel for that page, even if they'd already consented.
  if (TOKENIZED_ROUTES.includes(pathname)) return null;
  if (!consented) return null;

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');`}
    </Script>
  );
}

/**
 * Meta Pixel conversion events — the funnel the ads team reads in Events
 * Manager: PageView (MetaPixel.tsx) → ViewContent (a pack page) →
 * CompleteRegistration → InitiateCheckout (a top-up started) → FirstDeposit →
 * Purchase (a top-up settles, with its value, for ROAS); OpenPack (a pack
 * opened with balance) is auxiliary and never a Purchase.
 *
 * The visitor's cookie-banner answer decides everything here:
 * - accepted: sent, as soon as Meta's fbevents.js has loaded;
 * - not answered yet: held in memory, and sent if they accept on this page
 *   (the ad landing pack's ViewContent included) — gone if they leave;
 * - rejected: nothing is sent or kept, and what was held is dropped.
 *
 * Held work is a queue of callbacks that the snippet runs once fbevents.js has
 * loaded, so anything durable (clearing the sign-up marker, acking a deposit)
 * happens only once its event can really leave the browser — a page whose
 * pixel never loads (an ad blocker, a closed tab) leaves it for the next one.
 */
import { getConsent } from '@/lib/consent';

declare global {
  interface Window {
    /** Meta's stub; `callMethod` appears once fbevents.js has loaded. */
    fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown };
    /** Run, then emptied, by pixelSnippet once fbevents.js has loaded. */
    polycardsPixelQueue?: (() => void)[];
  }
}

/** Only production builds load the pixel: `next dev` would send localhost
 *  traffic (twice, under StrictMode) into the real one. */
export const PIXEL_ENABLED = process.env.NODE_ENV === 'production';

// Meta's own event names go through `track`; anything else is a custom event.
const STANDARD_EVENTS = new Set([
  'ViewContent',
  'CompleteRegistration',
  'InitiateCheckout',
  'Purchase',
]);

/**
 * Meta's base snippet (it defines the fbq stub and loads fbevents.js) plus
 * init + PageView — and, once fbevents.js has loaded, whatever was held for
 * it. Lives beside the queue it drains so the two names can't drift apart.
 * MetaPixel renders it once the visitor has accepted.
 */
export function pixelSnippet(pixelId: string): string {
  return `!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.onload=function(){(f.polycardsPixelQueue||[]).forEach(function(q){q()});
f.polycardsPixelQueue=[]};
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');
fbq('track', 'PageView');`;
}

/** Run `send` once the pixel is live on this page — see the file comment. */
function whenPixelLive(send: () => void): void {
  if (getConsent() === 'rejected') return;
  const guarded = () => {
    // fbq is third-party code: a throw in it must never break the caller
    // (a paid roll, a sign-up).
    try {
      send();
    } catch {
      // Nothing to recover; the event is simply not sent.
    }
  };
  // The stub alone only queues: an event is out only once fbevents.js runs.
  if (window.fbq?.callMethod) guarded();
  else (window.polycardsPixelQueue ??= []).push(guarded);
}

function fire(
  event: string,
  params: Record<string, unknown>,
  eventId?: string,
): void {
  const method = STANDARD_EVENTS.has(event) ? 'track' : 'trackCustom';
  if (eventId) window.fbq?.(method, event, params, { eventID: eventId });
  else window.fbq?.(method, event, params);
}

/**
 * Send one pixel event under the rules above. `eventId` pairs it with a
 * server-side (Conversions API) copy of the same event if one is ever added.
 */
export function trackPixel(
  event: string,
  params: Record<string, unknown>,
  eventId?: string,
): void {
  whenPixelLive(() => fire(event, params, eventId));
}

/**
 * Cookie the server leaves when an account is created (markSignup in
 * lib/data/customer.ts), holding the method. A cookie, not a client call,
 * because the Google sign-up finishes in a server redirect — and because a
 * sign-up made before the visitor answers the banner must still count once
 * they accept. Readable by script by design; it carries nothing but 'email' or
 * 'google'.
 */
export const SIGNUP_MARKER = 'polycards.signup';

function readSignupMarker(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${SIGNUP_MARKER}=`))
    ?.slice(SIGNUP_MARKER.length + 1);
}

function clearSignupMarker(): void {
  document.cookie = `${SIGNUP_MARKER}=; path=/; max-age=0`;
}

/**
 * MetaPixel calls this whenever the visitor's answer may have changed. A "no"
 * drops everything held — a later "yes" in the same page must not send what
 * happened before it — and the sign-up marker; otherwise a waiting sign-up is
 * reported.
 */
export function syncConsent(): void {
  if (getConsent() === 'rejected') {
    window.polycardsPixelQueue = [];
    if (readSignupMarker()) clearSignupMarker();
    return;
  }
  reportSignup();
}

/** Report a waiting sign-up as CompleteRegistration, once. The marker is read
 *  and cleared only when the event can go out. */
export function reportSignup(): void {
  whenPixelLive(() => {
    const method = readSignupMarker();
    if (method !== 'email' && method !== 'google') return;
    fire('CompleteRegistration', { content_name: method });
    clearSignupMarker();
  });
}

export type SettledDeposit = {
  /** Our merchant reference — also the pixel eventID. */
  reference: string;
  /** RM actually credited. */
  amount: number;
  /** The account's first ever settled deposit. */
  first: boolean;
};

/** Whether a deposit read is worth making at all: never for a visitor who
 *  said no, nor where the pixel never loads. */
export function mayReportDeposits(): boolean {
  return PIXEL_ENABLED && getConsent() !== 'rejected';
}

/** References sent from this page: two reads can queue the same deposit
 *  before the first one's ack lands. */
const sentThisPage = new Set<string>();

/**
 * Report settled top-ups that no browser has reported yet (the backend keeps
 * that record, so a customer's devices don't each send them): Purchase — its
 * value is what ROAS reads — for each, plus FirstDeposit for the account's
 * first ever. `ack` then marks every offered one reported on the backend,
 * including any this page already sent: the ack is idempotent, and an earlier
 * one may have failed.
 */
export function reportDeposits(
  deposits: SettledDeposit[],
  ack: (references: string[]) => void,
): void {
  if (deposits.length === 0) return;
  whenPixelLive(() => {
    for (const deposit of deposits) {
      if (sentThisPage.has(deposit.reference)) continue;
      sentThisPage.add(deposit.reference);
      const params = { value: deposit.amount, currency: 'MYR' };
      fire('Purchase', params, deposit.reference);
      if (deposit.first) fire('FirstDeposit', params, deposit.reference);
    }
    ack(deposits.map((deposit) => deposit.reference));
  });
}

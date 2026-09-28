/**
 * Meta Pixel conversion events — the funnel the ads team reads in Events
 * Manager: PageView (MetaPixel.tsx) → ViewContent (a pack page) → OpenPack (a
 * roll lands), and CompleteRegistration → FirstDeposit → Purchase (a top-up
 * settles, with its value, for ROAS).
 *
 * Consent-gated exactly like the pixel itself: nothing is sent unless the
 * visitor accepted the cookie banner. A page's first effects run before the
 * pixel's afterInteractive snippet defines `fbq`, so calls made in that gap are
 * queued on window and replayed by the snippet right after its init.
 */
import { getConsent } from '@/lib/consent';

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    /** Replayed (then emptied) by MetaPixel's snippet — see trackPixel. */
    polycardsPixelQueue?: unknown[][];
  }
}

// Meta's own event names go through `track`; anything else is a custom event.
const STANDARD_EVENTS = new Set([
  'ViewContent',
  'CompleteRegistration',
  'Purchase',
]);

/**
 * Send one pixel event. Returns false when it was dropped for lack of consent,
 * so a caller that must report something exactly once can keep it for later.
 * `eventId` lets Meta de-duplicate repeats — and pairs with a server-side
 * (Conversions API) copy of the same event if one is ever added.
 */
export function trackPixel(
  event: string,
  params: Record<string, unknown>,
  eventId?: string,
): boolean {
  if (getConsent() !== 'accepted') return false;
  const args: unknown[] = [
    STANDARD_EVENTS.has(event) ? 'track' : 'trackCustom',
    event,
    params,
  ];
  if (eventId) args.push({ eventID: eventId });
  if (window.fbq) window.fbq(...args);
  else (window.polycardsPixelQueue ??= []).push(args);
  return true;
}

/**
 * Cookie the server leaves when an account is created (markSignup in
 * lib/data/customer.ts), holding the method. A cookie, not a client call,
 * because the Google sign-up finishes in a server redirect — and because a
 * visitor who signs up BEFORE answering the cookie banner must still count
 * once they accept: MetaPixel re-runs reportSignup on consent. Readable by
 * script by design; it carries nothing but 'email' or 'google'.
 */
export const SIGNUP_MARKER = 'polycards.signup';

/** Report a waiting sign-up as CompleteRegistration, once. */
export function reportSignup(): void {
  const method = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${SIGNUP_MARKER}=`))
    ?.slice(SIGNUP_MARKER.length + 1);
  if (method !== 'email' && method !== 'google') return;
  // No consent yet: the marker stays for MetaPixel to retry on accept.
  if (!trackPixel('CompleteRegistration', { content_name: method })) return;
  document.cookie = `${SIGNUP_MARKER}=; path=/; max-age=0`;
}

export type SettledDeposit = {
  /** Our merchant reference — also the pixel eventID. */
  reference: string;
  /** RM actually credited. */
  amount: number;
  /** The account's first ever settled deposit. */
  first: boolean;
};

/**
 * Report top-ups that settled since this browser started watching this
 * account: Purchase (its value is what ROAS reads) for each, plus FirstDeposit
 * for the account's first ever. A deposit settles on the backend's sweep, often
 * after the customer is back on the site or gone, so this runs off the
 * backend's list of recently settled deposits (TopUpProvider's deposit watch)
 * rather than any in-page payment moment.
 *
 * The first run for an account on a browser only records what already
 * settled: those predate tracking here, and reporting them would replay
 * history — on the day this ships, after cleared storage, in every private
 * window.
 */
export function reportDeposits(
  customerId: string,
  settled: SettledDeposit[],
): void {
  const key = `polycards.pixel-deposits.${customerId}`;
  try {
    const raw = localStorage.getItem(key);
    const seen: string[] = raw === null ? [] : JSON.parse(raw);
    if (raw === null) {
      seen.push(...settled.map((deposit) => deposit.reference));
    } else {
      for (const deposit of settled) {
        if (seen.includes(deposit.reference)) continue;
        const params = { value: deposit.amount, currency: 'MYR' };
        // No consent yet: leave it unseen so a later read reports it.
        if (!trackPixel('Purchase', params, deposit.reference)) break;
        if (deposit.first)
          trackPixel('FirstDeposit', params, deposit.reference);
        seen.push(deposit.reference);
      }
    }
    localStorage.setItem(key, JSON.stringify(seen.slice(-20)));
  } catch {
    // Storage blocked or corrupt: skip rather than risk reporting twice.
  }
}

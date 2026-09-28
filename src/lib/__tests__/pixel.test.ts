// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_KEY } from '../consent';
import {
  pixelSnippet,
  reportDeposits,
  reportSignup,
  SIGNUP_MARKER,
  syncConsent,
  trackPixel,
} from '../pixel';

// What the ads team reads in Events Manager comes only from these calls, so
// what is pinned here is the contract they rely on: the banner answer decides
// (sent / held / dropped), held work runs once fbevents.js has loaded, and a
// sign-up or deposit is only marked done once its event can really go out.

/** fbq as it is once fbevents.js has loaded (it adds `callMethod`). */
const fbq = Object.assign(vi.fn(), { callMethod: vi.fn() });
const consent = (state: 'accepted' | 'rejected') =>
  localStorage.setItem(CONSENT_KEY, state);
const setMarker = (value: string) =>
  (document.cookie = `${SIGNUP_MARKER}=${value}; path=/`);
/** What the snippet does once fbevents.js has loaded. */
const loadPixel = () => {
  window.fbq = fbq;
  (window.polycardsPixelQueue ?? []).forEach((run) => run());
  window.polycardsPixelQueue = [];
};

beforeEach(() => {
  localStorage.clear();
  document.cookie = `${SIGNUP_MARKER}=; path=/; max-age=0`;
  fbq.mockReset();
  delete window.fbq;
  delete window.polycardsPixelQueue;
});

afterEach(() => {
  delete window.fbq;
  delete window.polycardsPixelQueue;
});

describe('trackPixel', () => {
  it('sends standard events with track, ours with trackCustom, eventID last', () => {
    consent('accepted');
    window.fbq = fbq;
    trackPixel('Purchase', { value: 50, currency: 'MYR' }, 'PC-1');
    trackPixel('InitiateCheckout', { value: 300, currency: 'MYR' });
    trackPixel('OpenPack', { value: 12, currency: 'MYR' });
    expect(fbq.mock.calls).toEqual([
      [
        'track',
        'Purchase',
        { value: 50, currency: 'MYR' },
        { eventID: 'PC-1' },
      ],
      ['track', 'InitiateCheckout', { value: 300, currency: 'MYR' }],
      ['trackCustom', 'OpenPack', { value: 12, currency: 'MYR' }],
    ]);
  });

  // The ad landing page: ViewContent fires in the first render, before the
  // visitor has answered the banner. Accepting on that page must still count it.
  it('holds an event until the visitor accepts and the pixel loads', () => {
    trackPixel('ViewContent', { content_ids: ['p1'] });
    expect(fbq).not.toHaveBeenCalled();
    consent('accepted');
    loadPixel();
    expect(fbq).toHaveBeenCalledWith('track', 'ViewContent', {
      content_ids: ['p1'],
    });
  });

  // An ad blocker lets the snippet define the stub but never loads
  // fbevents.js: nothing leaves, so nothing may count as sent.
  it('treats the stub alone as not loaded', () => {
    consent('accepted');
    window.fbq = vi.fn() as unknown as typeof window.fbq;
    trackPixel('ViewContent', { content_ids: ['p1'] });
    expect(window.fbq).not.toHaveBeenCalled();
    expect(window.polycardsPixelQueue).toHaveLength(1);
  });

  it('drops the event for a visitor who rejected', () => {
    consent('rejected');
    trackPixel('ViewContent', { content_ids: ['p1'] });
    loadPixel();
    expect(fbq).not.toHaveBeenCalled();
  });

  // fbq is third-party code; a throw in it must not break a paid roll.
  it('never lets a throwing fbq reach the caller', () => {
    consent('accepted');
    window.fbq = Object.assign(
      () => {
        throw new Error('fbevents blew up');
      },
      { callMethod: vi.fn() },
    );
    expect(() => trackPixel('OpenPack', { value: 12 })).not.toThrow();
  });
});

describe('syncConsent', () => {
  // "Rejected: nothing is sent or kept" — including what was held before the
  // answer, which a later "yes" in the same page must not send.
  it('drops held events and the sign-up marker on a reject', () => {
    trackPixel('ViewContent', { content_ids: ['p1'] });
    setMarker('email');
    consent('rejected');
    syncConsent();
    expect(window.polycardsPixelQueue).toEqual([]);
    expect(document.cookie).not.toContain(SIGNUP_MARKER);

    consent('accepted');
    loadPixel();
    expect(fbq).not.toHaveBeenCalled();
  });

  it('reports a waiting sign-up otherwise', () => {
    setMarker('google');
    consent('accepted');
    syncConsent();
    loadPixel();
    expect(fbq).toHaveBeenCalledWith('track', 'CompleteRegistration', {
      content_name: 'google',
    });
  });
});

describe('reportSignup', () => {
  it('does nothing when no account was just created', () => {
    consent('accepted');
    window.fbq = fbq;
    reportSignup();
    expect(fbq).not.toHaveBeenCalled();
  });

  // The marker is cleared only when the event can go out: a page that never
  // loads the pixel (another tab's Accept, /reset-password, a blocker) keeps it.
  it('keeps the marker until the event is sent, then reports it once', () => {
    setMarker('google');
    reportSignup();
    reportSignup();
    expect(document.cookie).toContain(`${SIGNUP_MARKER}=google`);

    consent('accepted');
    loadPixel();
    expect(fbq.mock.calls).toEqual([
      ['track', 'CompleteRegistration', { content_name: 'google' }],
    ]);
    expect(document.cookie).not.toContain(SIGNUP_MARKER);
  });

  it('ignores a marker holding anything but a known method', () => {
    consent('accepted');
    window.fbq = fbq;
    setMarker('<script>');
    reportSignup();
    expect(fbq).not.toHaveBeenCalled();
  });
});

describe('reportDeposits', () => {
  const deposit = (reference: string, first = false) => ({
    reference,
    amount: 100,
    first,
  });

  it('sends Purchase (+FirstDeposit for the first ever), then acks them', () => {
    consent('accepted');
    window.fbq = fbq;
    const ack = vi.fn();
    reportDeposits([deposit('PC-A1', true), deposit('PC-A2')], ack);

    expect(fbq.mock.calls).toEqual([
      [
        'track',
        'Purchase',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-A1' },
      ],
      [
        'trackCustom',
        'FirstDeposit',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-A1' },
      ],
      [
        'track',
        'Purchase',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-A2' },
      ],
    ]);
    expect(ack).toHaveBeenCalledWith(['PC-A1', 'PC-A2']);
  });

  // Two reads (mount, then a payment leaving the pending list) can offer the
  // same deposit before the first ack lands. Sent once; acked again, since
  // the ack is idempotent and the first one may have failed.
  it('sends a deposit once per page, and re-acks it when offered again', () => {
    consent('accepted');
    window.fbq = fbq;
    const ack = vi.fn();
    reportDeposits([deposit('PC-B1')], ack);
    reportDeposits([deposit('PC-B1')], ack);
    expect(fbq).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls).toEqual([[['PC-B1']], [['PC-B1']]]);
  });

  // Unacked means the backend offers it again on a later read, so nothing is
  // lost when the pixel never loads.
  it('neither sends nor acks until fbevents.js has loaded', () => {
    consent('accepted');
    window.fbq = vi.fn() as unknown as typeof window.fbq;
    const ack = vi.fn();
    reportDeposits([deposit('PC-C1')], ack);
    expect(ack).not.toHaveBeenCalled();

    loadPixel();
    expect(fbq).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith(['PC-C1']);
  });

  it('neither sends nor acks for a visitor who rejected', () => {
    consent('rejected');
    const ack = vi.fn();
    reportDeposits([deposit('PC-D1')], ack);
    loadPixel();
    expect(fbq).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
});

// MetaPixel renders this string; the queue it drains is the one above. Run it
// for real so a rename on either side fails here instead of silently dropping
// every held landing-page event.
describe('pixelSnippet', () => {
  it('inits and sends PageView at once, and runs held work when fbevents.js loads', () => {
    document.head.appendChild(document.createElement('script'));
    consent('accepted');
    trackPixel('ViewContent', { content_ids: ['p1'] });

    new Function(pixelSnippet('123'))();

    const stub = window.fbq as unknown as { queue: ArrayLike<unknown>[] };
    const calls = () => stub.queue.map((call) => Array.from(call).slice(0, 2));
    expect(calls()).toEqual([
      ['init', '123'],
      ['track', 'PageView'],
    ]);
    expect(window.polycardsPixelQueue).toHaveLength(1);

    const loader = document.querySelector<HTMLScriptElement>(
      'script[src*="fbevents.js"]',
    );
    loader?.onload?.(new Event('load'));
    expect(calls()).toEqual([
      ['init', '123'],
      ['track', 'PageView'],
      ['track', 'ViewContent'],
    ]);
    expect(window.polycardsPixelQueue).toEqual([]);
  });
});

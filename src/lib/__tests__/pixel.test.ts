// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_KEY } from '../consent';
import {
  reportDeposits,
  reportSignup,
  SIGNUP_MARKER,
  trackPixel,
} from '../pixel';

// What the ads team reads in Events Manager comes only from these calls, so
// what is pinned here is the contract they rely on: nothing without consent,
// nothing lost to the snippet's late load, and each sign-up / deposit reported
// exactly once.

const fbq = vi.fn();
const accept = () => localStorage.setItem(CONSENT_KEY, 'accepted');
const pixelCalls = () => fbq.mock.calls.map((call) => call.slice(0, 2));

beforeEach(() => {
  localStorage.clear();
  document.cookie = `${SIGNUP_MARKER}=; path=/; max-age=0`;
  fbq.mockClear();
  window.fbq = fbq;
  delete window.polycardsPixelQueue;
});

afterEach(() => {
  delete window.fbq;
});

describe('trackPixel', () => {
  it('drops the event without consent', () => {
    expect(trackPixel('ViewContent', { content_ids: ['p1'] })).toBe(false);
    localStorage.setItem(CONSENT_KEY, 'rejected');
    expect(trackPixel('ViewContent', { content_ids: ['p1'] })).toBe(false);
    expect(fbq).not.toHaveBeenCalled();
  });

  it('sends standard events with track, ours with trackCustom, eventID last', () => {
    accept();
    trackPixel('Purchase', { value: 50, currency: 'MYR' }, 'PC-1');
    trackPixel('OpenPack', { mode: 'paid' });
    expect(fbq.mock.calls).toEqual([
      [
        'track',
        'Purchase',
        { value: 50, currency: 'MYR' },
        { eventID: 'PC-1' },
      ],
      ['trackCustom', 'OpenPack', { mode: 'paid' }],
    ]);
  });

  // A page's first effects run before the afterInteractive snippet defines
  // fbq; MetaPixel's snippet replays this queue right after its init.
  it('queues until the snippet has defined fbq', () => {
    accept();
    delete window.fbq;
    expect(trackPixel('ViewContent', { content_ids: ['p1'] })).toBe(true);
    expect(window.polycardsPixelQueue).toEqual([
      ['track', 'ViewContent', { content_ids: ['p1'] }],
    ]);
  });
});

describe('reportSignup', () => {
  it('does nothing when no account was just created', () => {
    accept();
    reportSignup();
    expect(fbq).not.toHaveBeenCalled();
  });

  // The visitor signed up before answering the cookie banner: the marker must
  // outlive this call so MetaPixel can report it once they accept.
  it('keeps the marker until consent, then reports it once', () => {
    document.cookie = `${SIGNUP_MARKER}=google; path=/`;
    reportSignup();
    expect(fbq).not.toHaveBeenCalled();
    expect(document.cookie).toContain(`${SIGNUP_MARKER}=google`);

    accept();
    reportSignup();
    reportSignup();
    expect(fbq.mock.calls).toEqual([
      ['track', 'CompleteRegistration', { content_name: 'google' }],
    ]);
    expect(document.cookie).not.toContain(SIGNUP_MARKER);
  });

  it('ignores a marker holding anything but a known method', () => {
    accept();
    document.cookie = `${SIGNUP_MARKER}=<script>; path=/`;
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

  // Deposits that settled before this browser watched the account predate
  // tracking here — reporting them would replay history on the day this
  // ships, after cleared storage, and in every private window.
  it('records what already settled on the first run, without reporting it', () => {
    accept();
    reportDeposits('cus_1', [deposit('PC-old', true)]);
    reportDeposits('cus_1', [deposit('PC-old', true)]);
    expect(fbq).not.toHaveBeenCalled();
  });

  it('reports a newly settled deposit once, with FirstDeposit for the first ever', () => {
    accept();
    reportDeposits('cus_1', []);
    reportDeposits('cus_1', [deposit('PC-1', true)]);
    reportDeposits('cus_1', [deposit('PC-2'), deposit('PC-1', true)]);

    expect(fbq.mock.calls).toEqual([
      [
        'track',
        'Purchase',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-1' },
      ],
      [
        'trackCustom',
        'FirstDeposit',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-1' },
      ],
      [
        'track',
        'Purchase',
        { value: 100, currency: 'MYR' },
        { eventID: 'PC-2' },
      ],
    ]);
  });

  it('holds a deposit that settled before consent and reports it after', () => {
    reportDeposits('cus_1', []);
    reportDeposits('cus_1', [deposit('PC-1')]);
    expect(fbq).not.toHaveBeenCalled();

    accept();
    reportDeposits('cus_1', [deposit('PC-1')]);
    expect(pixelCalls()).toEqual([['track', 'Purchase']]);
  });

  // Another account on the same browser has its own history: its old
  // deposits must baseline, not fire because this browser watched someone else.
  it('keeps each account on the browser separate', () => {
    accept();
    reportDeposits('cus_1', []);
    reportDeposits('cus_2', [deposit('PC-9')]);
    expect(fbq).not.toHaveBeenCalled();
  });
});

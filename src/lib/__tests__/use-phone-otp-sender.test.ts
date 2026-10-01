// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The human check in front of every OTP send. Turnstile itself is faked: these
// pin what the sender does with it — one FRESH single-use token per send (a
// resend replaying a spent token would be refused as timeout-or-duplicate),
// the widget removed after each, no send at all when the check fails, and the
// whole thing inert while no site key is configured.

const startPhoneOtp = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  channel: 'sms' as const,
}));
vi.mock('@/lib/actions/phone-verification', () => ({ startPhoneOtp }));

type Options = {
  callback: (token: string) => void;
  'error-callback': (code: string) => unknown;
  [option: string]: unknown;
};
const fakeTurnstile = (outcome: (o: Options) => void) => {
  let n = 0;
  return {
    render: vi.fn((_host: HTMLElement, options: Options) => {
      const id = `w${++n}`;
      queueMicrotask(() => outcome(options));
      return id;
    }),
    remove: vi.fn(),
  };
};

const INPUT = { phone: '+60123456789', purpose: 'signup' as const };

async function load(siteKey: string | undefined) {
  vi.resetModules();
  if (siteKey) vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', siteKey);
  else vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
  return import('../use-phone-otp-sender');
}

let host: HTMLDivElement;
beforeEach(() => {
  startPhoneOtp.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  delete (window as { turnstile?: unknown }).turnstile;
  document.head.replaceChildren();
  vi.unstubAllEnvs();
});

describe('sendPhoneOtp', () => {
  test('without a site key it sends the input untouched and loads nothing', async () => {
    const { sendPhoneOtp } = await load(undefined);
    await sendPhoneOtp(INPUT, host);
    expect(startPhoneOtp).toHaveBeenCalledWith(INPUT);
    expect(document.head.querySelector('script')).toBeNull();
  });

  test('mints a fresh token for every send and removes each widget', async () => {
    let token = 0;
    const turnstile = fakeTurnstile((o) => o.callback(`tok-${++token}`));
    (window as { turnstile?: unknown }).turnstile = turnstile;
    const { sendPhoneOtp } = await load('site-key');

    await sendPhoneOtp(INPUT, host);
    await sendPhoneOtp({ ...INPUT, channel: 'call' }, host);

    expect(startPhoneOtp.mock.calls).toEqual([
      [{ ...INPUT, turnstileToken: 'tok-1' }],
      [{ ...INPUT, channel: 'call', turnstileToken: 'tok-2' }],
    ]);
    expect(turnstile.render).toHaveBeenCalledTimes(2);
    expect(turnstile.render.mock.calls[0]?.[1]).toMatchObject({
      sitekey: 'site-key',
      action: 'phone-otp',
      appearance: 'interaction-only',
    });
    expect(turnstile.remove.mock.calls).toEqual([['w1'], ['w2']]);
  });

  // The normal widget is a fixed 300 px; a 360 px phone leaves ~270 px in the
  // signup dialog, so narrower containers get the 150 px compact widget.
  test('sizes the widget to the slot container', async () => {
    const turnstile = fakeTurnstile((o) => o.callback('tok'));
    (window as { turnstile?: unknown }).turnstile = turnstile;
    const { sendPhoneOtp } = await load('site-key');
    const wrap = document.createElement('div');
    wrap.appendChild(host);
    document.body.appendChild(wrap);

    Object.defineProperty(wrap, 'clientWidth', {
      value: 270,
      configurable: true,
    });
    await sendPhoneOtp(INPUT, host);
    Object.defineProperty(wrap, 'clientWidth', {
      value: 300,
      configurable: true,
    });
    await sendPhoneOtp(INPUT, host);

    expect(turnstile.render.mock.calls.map((c) => c[1].size)).toEqual([
      'compact',
      'normal',
    ]);
    wrap.remove();
  });

  test('a failed check sends nothing and asks for an immediate retry', async () => {
    const turnstile = fakeTurnstile((o) => o['error-callback']('300030'));
    (window as { turnstile?: unknown }).turnstile = turnstile;
    const { sendPhoneOtp } = await load('site-key');

    await expect(sendPhoneOtp(INPUT, host)).resolves.toEqual({
      ok: false,
      error: 'Security check failed. Please try again.',
      retryAfterSeconds: 1,
    });
    expect(startPhoneOtp).not.toHaveBeenCalled();
    expect(turnstile.remove).toHaveBeenCalledWith('w1');
  });

  test('loads the Turnstile script on first use, then reuses it', async () => {
    const { sendPhoneOtp } = await load('site-key');
    const sending = sendPhoneOtp(INPUT, host);
    const script = document.head.querySelector('script')!;
    expect(script.src).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    );
    (window as { turnstile?: unknown }).turnstile = fakeTurnstile((o) =>
      o.callback('tok'),
    );
    script.dispatchEvent(new Event('load'));
    await sending;
    await sendPhoneOtp(INPUT, host);
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
    expect(startPhoneOtp).toHaveBeenCalledTimes(2);
  });

  // An ad blocker or a CSP miss: the check can never complete, so the send
  // must fail visibly instead of hanging — and a later attempt retries.
  test('a script that fails to load fails the send and is retried next time', async () => {
    const { sendPhoneOtp } = await load('site-key');
    const sending = sendPhoneOtp(INPUT, host);
    document.head.querySelector('script')!.dispatchEvent(new Event('error'));
    await expect(sending).resolves.toMatchObject({ ok: false });
    expect(startPhoneOtp).not.toHaveBeenCalled();

    void sendPhoneOtp(INPUT, host);
    expect(document.head.querySelectorAll('script')).toHaveLength(2);
  });

  test('with no mounted slot it refuses rather than sending unchecked', async () => {
    (window as { turnstile?: unknown }).turnstile = fakeTurnstile((o) =>
      o.callback('tok'),
    );
    const { sendPhoneOtp } = await load('site-key');
    await expect(sendPhoneOtp(INPUT, null)).resolves.toMatchObject({
      ok: false,
    });
    expect(startPhoneOtp).not.toHaveBeenCalled();
  });
});

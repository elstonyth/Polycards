import { useCallback, useRef } from 'react';
import { startPhoneOtp } from '@/lib/actions/phone-verification';

/**
 * Every client-side OTP send goes through here, so each one carries a fresh
 * Cloudflare Turnstile token for the backend's requireTurnstile guard
 * (backend/packages/api/src/api/utils/turnstile-guard.ts).
 *
 * Why: the start route bills a real SMS ($0.3389 a segment to Malaysia) per
 * call, and on 2026-10-01 a script was still requesting signup codes for fresh
 * +60 numbers every ten minutes through startPhoneOtp's server action. The
 * backend's limiters key on the phone or the request IP, and neither can tell
 * a script from a person; this check can.
 *
 * Tokens are SINGLE-USE and live 300 s, so one is minted per send — first
 * send, resend and the call button alike — in a widget rendered into the
 * caller's slot and removed once it answers. `appearance: 'interaction-only'`
 * keeps the slot empty for almost everyone; the few visitors Cloudflare wants
 * a click from see the checkbox right where they pressed Send, inside the same
 * dialog and tab order (a floating overlay would sit outside a modal's focus
 * trap).
 *
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY is inlined at build (root Dockerfile ARG).
 * Unset, nothing loads and sends go out exactly as before.
 */
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
/** Must equal TURNSTILE_ACTION in the backend guard. */
const ACTION = 'phone-otp';
const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// Generous: an interactive challenge waits on a person. Turnstile's own
// timeout-callback normally answers first; this only catches a hung widget.
const CHALLENGE_TIMEOUT_MS = 120_000;
// The normal widget is a fixed 300 px; a 360 px phone leaves ~270 px in the
// signup dialog, so narrower containers get the 150 px compact widget.
const NORMAL_WIDGET_PX = 300;

type SendInput = Omit<Parameters<typeof startPhoneOtp>[0], 'turnstileToken'>;
type TurnstileOptions = Record<string, unknown>;
type Turnstile = {
  render: (
    host: HTMLElement,
    options: TurnstileOptions,
  ) => string | null | undefined;
  remove: (widgetId: string) => void;
};
const turnstileOf = () => (window as { turnstile?: Turnstile }).turnstile;

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  const ready = turnstileOf();
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      const api = turnstileOf();
      if (api) resolve(api);
      else reject(new Error('Turnstile did not initialise'));
    };
    script.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // A blocked or flaky load must not poison every later attempt.
    loading = null;
    throw error;
  });
  return loading;
}

async function mintToken(host: HTMLElement): Promise<string> {
  const turnstile = await loadTurnstile();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let widgetId: string | null | undefined;
    const settle = (token: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (widgetId) turnstile.remove(widgetId);
      if (token) resolve(token);
      else reject(new Error('Security check failed'));
    };
    const timer = setTimeout(() => settle(null), CHALLENGE_TIMEOUT_MS);
    try {
      widgetId = turnstile.render(host, {
        sitekey: SITE_KEY,
        action: ACTION,
        appearance: 'interaction-only',
        theme: 'dark',
        // Measured on the container: the empty slot itself is display:none.
        size:
          (host.parentElement?.clientWidth ?? 0) >= NORMAL_WIDGET_PX
            ? 'normal'
            : 'compact',
        // The token goes to the server action, not a form post.
        'response-field': false,
        callback: (token: string) => settle(token),
        // Returning true marks the error handled, so Turnstile does not also
        // throw it to the console.
        'error-callback': () => {
          settle(null);
          return true;
        },
        'timeout-callback': () => settle(null),
        'unsupported-callback': () => settle(null),
      });
    } catch {
      settle(null);
    }
  });
}

/** One send: mint a token when the check is configured, then call the action.
 *  `host` is the slot the widget renders into. Exported for tests. */
export async function sendPhoneOtp(input: SendInput, host: HTMLElement | null) {
  if (!SITE_KEY) return startPhoneOtp(input);
  let turnstileToken: string;
  try {
    if (!host) throw new Error('Security check is not mounted');
    turnstileToken = await mintToken(host);
  } catch {
    // Same copy as the backend refusal; nothing was spent, so no cooldown.
    return {
      ok: false as const,
      error: 'Security check failed. Please try again.',
      retryAfterSeconds: 1,
    };
  }
  return startPhoneOtp({ ...input, turnstileToken });
}

/**
 * `challengeRef` goes on an empty element next to the Send button; `send` is
 * a drop-in for startPhoneOtp.
 *
 * Give that element `isolate`. Inside a liquid-glass panel (an SVG
 * backdrop-filter, lib/liquid-glass.ts), Chromium blurs the panel's own text
 * while the challenge's cross-origin iframe is on screen, and isolating the
 * slot's stacking context stops it. That was verified in Chromium on the
 * signup dialog with the forced-interactive test key.
 */
export function usePhoneOtpSender() {
  const challengeRef = useRef<HTMLDivElement>(null);
  const send = useCallback(
    (input: SendInput) => sendPhoneOtp(input, challengeRef.current),
    [],
  );
  return { challengeRef, send };
}

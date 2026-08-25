'use client';

import { useEffect, useState } from 'react';
import { Gift, Info, X } from 'lucide-react';
import { openAuth } from '@/components/AuthButton';
import { Pill } from '@/components/ui/pill';

/**
 * The landing half of the referral link. `/invite/<handle>` redirects to
 * `/?invite=…`; this greets the visitor and — for a genuine invite — opens the
 * signup form, because the whole point of the link is a new account.
 *
 * Reads `window.location.search` in an effect rather than `useSearchParams()`
 * ON PURPOSE: the home page is ISR-cached and visitor-agnostic (see the note
 * in app/page.tsx), and a `useSearchParams()` read would opt its whole tree
 * into per-request rendering. This runs client-only, so the cache is untouched.
 *
 * The param is stripped from the URL immediately, so a refresh or a shared
 * screenshot-URL doesn't re-open the modal.
 */
type InviteState =
  | { kind: 'invited'; handle: string }
  | { kind: 'has-account' | 'unknown' };

export default function InviteWelcome() {
  const [state, setState] = useState<InviteState | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (!invite) return;

    // Clean the URL first — whatever happens next, this must not replay.
    params.delete('invite');
    const qs = params.toString();
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (qs ? `?${qs}` : ''),
    );

    const next: InviteState =
      invite === 'has-account' || invite === 'unknown'
        ? { kind: invite }
        : { kind: 'invited', handle: invite };

    // Deliberate post-mount sync read: the invite lives in the URL, which does
    // not exist during SSR, so this cannot be a lazy initialiser. Same pattern
    // as the other intentional effect reads in this app (see CookieConsent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next);
    if (next.kind !== 'invited') return;

    // Give the header a beat to mount its auth listener before dispatching.
    const t = setTimeout(() => openAuth('signup'), 400);
    return () => clearTimeout(t);
  }, []);

  if (!state) return null;

  const invited = state.kind === 'invited';
  const copy = invited
    ? {
        title: `${state.handle} invited you`,
        body: 'Create your account to join their crew — you both earn as you rip.',
        cta: 'Create account',
      }
    : state.kind === 'has-account'
      ? {
          title: 'You already have an account',
          body: 'Invite links only apply to brand-new signups, so this one has no effect on your account.',
          cta: null,
        }
      : {
          title: "That invite link isn't valid",
          body: 'The link may be mistyped or the account is gone. You can still sign up normally.',
          cta: null,
        };

  return (
    <div role="status" className="px-fluid pt-4">
      <div className="mx-auto flex w-full max-w-2xl items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900">
          {invited ? (
            <Gift className="text-chase h-4.5 w-4.5" aria-hidden />
          ) : (
            <Info className="h-4.5 w-4.5 text-neutral-400" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{copy.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">
            {copy.body}
          </p>
          {copy.cta && (
            <Pill size="sm" className="mt-3" onClick={() => openAuth('signup')}>
              {copy.cta}
            </Pill>
          )}
        </div>
        <button
          type="button"
          onClick={() => setState(null)}
          aria-label="Dismiss"
          className="rounded-lg p-1 text-neutral-500 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

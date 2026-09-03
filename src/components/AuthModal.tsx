'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { useModalA11y } from '@/lib/use-modal-a11y';
import AuthForm from './AuthForm';

type AuthMode = 'login' | 'signup';

/**
 * Global auth modal — mounted once (in SiteHeader, always present). Opens in response
 * to the `polycards:auth` window event dispatched by openAuth() (see AuthButton). Matches
 * the live site's modal login/signup; the clone has no /login or /signup pages.
 *
 * Accessibility: as an `aria-modal` dialog it moves focus into the panel on open, traps
 * Tab/Shift+Tab within it, and restores focus to the triggering element on close
 * (WCAG 2.4.3 Focus Order, 2.1.2 No Keyboard Trap). Esc and backdrop click also close.
 */
export default function AuthModal() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  // Carried by the /r/<code> landing (openAuth options) into the signup form.
  const [referralCode, setReferralCode] = useState<string | undefined>();
  const panelRef = useRef<HTMLDivElement>(null);

  const dismiss = () => setOpen(false);

  // Liquid-glass rim on the panel — subtle settings; the interior must stay
  // legible behind a form. Safari/Firefox get the frosted fallback.
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (
        e as CustomEvent<{ mode?: AuthMode; referralCode?: string }>
      ).detail;
      // Whatever has focus now is the trigger; useModalA11y captures it when
      // the open flip reaches its effect and restores it on close.
      setMode(detail?.mode ?? 'login');
      setReferralCode(detail?.referralCode);
      setOpen(true);
    };
    window.addEventListener('polycards:auth', onOpen);
    return () => window.removeEventListener('polycards:auth', onOpen);
  }, []);

  // Open automatically when redirected here with ?auth=login|signup (e.g. the
  // account gate sends unauthenticated users to /?auth=login), then clean the URL.
  // Reuses the event path above (avoids a synchronous setState in this effect).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('auth');
    if (requested !== 'login' && requested !== 'signup') return;
    window.dispatchEvent(
      new CustomEvent('polycards:auth', { detail: { mode: requested } }),
    );
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    window.history.replaceState({}, '', url);
  }, []);

  // Focus into the panel, Tab trap, Escape, body-scroll lock and focus restore.
  // The hook re-runs only when `open` flips, so switching login↔signup no longer
  // tears the listener down and bounces focus off the control just used — which
  // is what listing `mode` in the old hand-rolled effect's deps did.
  useModalA11y(panelRef, open, dismiss);

  // `open` only flips true via a client event (post-hydration), so createPortal is
  // never reached during SSR — no separate mounted gate needed.
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop: mouse-only close affordance, hidden from the a11y tree and tab order so
          it doesn't announce a duplicate "Close" — the X button and Esc cover AT/keyboard. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={dismiss}
        className="glass-stage absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'signup' ? 'Create account' : 'Log in'}
        tabIndex={-1}
        className="glass-panel relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border p-7 outline-none sm:p-8"
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        <AuthForm
          mode={mode}
          onSwitchMode={setMode}
          onSuccess={() => setOpen(false)}
          initialReferralCode={referralCode}
        />
      </div>
    </div>,
    document.body,
  );
}

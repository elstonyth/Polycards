'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { lockBodyScroll, unlockBodyScroll } from '@/lib/use-modal-a11y';
import AuthForm from './AuthForm';
import { useAuth } from './auth/AuthProvider';
import ReactivatePrompt, {
  useDeclineReactivation,
} from './auth/ReactivatePrompt';

// 'reactivate' is not a form the user can switch to — it is only ever arrived
// at, from the two places a login turns out to belong to a self-disabled
// account: /?auth=reactivate from the Google callback (see that route), and
// AuthForm handing the modal over when login/signup returns the selfDisabled
// variant. Both land on the same renderer so the dismiss handling below covers
// both; a second copy inside AuthForm is what let the X close on a live
// session.
type AuthMode = 'login' | 'signup' | 'reactivate';

// Tabbable-element selector used by the focus trap.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Global auth modal — mounted once (in SiteHeader, always present). Opens in response
 * to the `polycards:auth` window event dispatched by openAuth() (see AuthButton). Matches
 * the live site's modal login/signup; the clone has no /login or /signup pages.
 *
 * Accessibility: as an `aria-modal` dialog it moves focus into the panel on open, traps
 * Tab/Shift+Tab within it, and restores focus to the triggering element on close
 * (WCAG 2.4.3 Focus Order, 2.1.2 No Keyboard Trap). Esc and backdrop click also close —
 * except in 'reactivate' mode, where every dismissal means "Not now" (see `dismiss`).
 */
export default function AuthModal() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const { refresh } = useAuth();
  const decline = useDeclineReactivation();

  /**
   * Every way out of this modal that is not a button inside it: the X, the
   * backdrop and Esc.
   *
   * In 'reactivate' mode that is NOT a close, it is "Not now". The session
   * cookie is already set by the time the prompt appears, so a silent close
   * leaves the customer holding a live token that the session guard 403s on
   * everything except the four carved-out paths — the header still renders them
   * signed in, /settings still loads, and nothing says the way back is to log
   * out and log in again. Routed through the prompt's own decline path so the
   * two cannot drift.
   *
   * Closed even if the logout call fails — caught rather than left to reject,
   * since there is no error surface out here. That is exactly today's behaviour
   * (which never attempted a logout at all), and the Settings page now carries
   * a Reactivate action for a customer who ends up stranded anyway. The prompt's
   * own "Not now" button keeps its retry message; this path cannot show one.
   */
  const dismiss = () => {
    if (mode !== 'reactivate') {
      setOpen(false);
      return;
    }
    decline()
      .catch(() => undefined)
      .finally(() => setOpen(false));
  };

  // Liquid-glass rim on the panel — subtle settings; the interior must stay
  // legible behind a form. Safari/Firefox get the frosted fallback.
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: AuthMode }>).detail;
      // Remember whatever had focus so it can be restored when the modal closes.
      triggerRef.current = document.activeElement as HTMLElement | null;
      setMode(detail?.mode ?? 'login');
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
    if (
      requested !== 'login' &&
      requested !== 'signup' &&
      requested !== 'reactivate'
    )
      return;
    window.dispatchEvent(
      new CustomEvent('polycards:auth', { detail: { mode: requested } }),
    );
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    window.history.replaceState({}, '', url);
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;

    // Move focus into the dialog on open (WCAG 2.4.3). Guarded because `mode`
    // is in this effect's deps — Esc has to see the CURRENT mode to route a
    // reactivate dismissal through the decline path — and without the guard,
    // switching login↔signup would yank focus off the control just used.
    if (!panel?.contains(document.activeElement)) panel?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
        return;
      }
      // Trap focus within the dialog so background content stays unreachable (WCAG 2.1.2).
      if (e.key !== 'Tab' || !panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusables.length === 0) return;
      // length === 0 is checked above; both indices are in bounds
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    lockBodyScroll();
    return () => {
      document.removeEventListener('keydown', onKey);
      unlockBodyScroll();
      // Restore focus to the element that opened the modal (WCAG 2.4.3).
      triggerRef.current?.focus();
    };
    // `dismiss` is rebuilt every render, so listing it would tear down and
    // re-bind this listener (and re-run the focus/scroll-lock setup) on every
    // parent render. `mode` is the only thing inside it this listener has to
    // see freshly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

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
        aria-label={
          mode === 'reactivate'
            ? 'Reactivate account'
            : mode === 'signup'
              ? 'Create account'
              : 'Log in'
        }
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
        {mode === 'reactivate' ? (
          <ReactivatePrompt
            onDone={(reactivated) => {
              setOpen(false);
              if (!reactivated) return;
              // Nothing behind this modal knows the account came back: the
              // Google callback landed on the home page holding a cookie the
              // guard was refusing on every route but a handful.
              //
              // Both refreshes, because the two entry points arrive here in
              // different states. On the emailpass path login returned the
              // self-disabled variant, so it never called setCustomer and the
              // auth context is empty — router.refresh() cannot fix that, since
              // AuthProvider reads /api/me rather than the server render. On
              // the Google path the context is already populated and the re-read
              // is a no-op.
              void refresh();
              router.refresh();
            }}
          />
        ) : (
          <AuthForm
            mode={mode}
            onSwitchMode={setMode}
            onSuccess={() => setOpen(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

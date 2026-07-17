'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { liquidGlass } from '@/lib/liquid-glass';
import AuthForm from './AuthForm';

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
 * (WCAG 2.4.3 Focus Order, 2.1.2 No Keyboard Trap). Esc and backdrop click also close.
 */
export default function AuthModal() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: 'login' | 'signup' }>).detail;
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
    if (requested !== 'login' && requested !== 'signup') return;
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

    // Move focus into the dialog on open (WCAG 2.4.3).
    panel?.focus();

    // Liquid glass rim refraction on the panel (subtle settings — the interior
    // must stay legible behind a form). Safari/Firefox get the frosted fallback.
    const glass = panel
      ? liquidGlass(panel, {
          scale: -60,
          chroma: 4,
          blur: 6,
          saturate: 1.4,
          fallbackBlur: 24,
        })
      : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      glass?.destroy();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the element that opened the modal (WCAG 2.4.3).
      triggerRef.current?.focus();
    };
  }, [open]);

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
        onClick={() => setOpen(false)}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'signup' ? 'Create account' : 'Log in'}
        tabIndex={-1}
        className="relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-neutral-950/45 p-7 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(255,255,255,0.04)] outline-none sm:p-8"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
        <AuthForm
          mode={mode}
          onSwitchMode={setMode}
          onSuccess={() => setOpen(false)}
        />
      </div>
    </div>,
    document.body,
  );
}

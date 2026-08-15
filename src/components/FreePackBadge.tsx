'use client';

import Link from 'next/link';
import Image from 'next/image';
import { openAuth } from '@/components/AuthButton';
import type { FreePackState } from '@/lib/data/free-pack';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useConsent } from '@/lib/use-consent';
import { cn } from '@/lib/utils';

/**
 * The free welcome pack's ONLY entry point — a floating badge on /slots.
 *
 * Two variants sharing one visual:
 *  - `claim`  — an eligible customer; links to the (uncataloged) pack page.
 *  - `signup` — a logged-out visitor while an active free pack exists; opens
 *    the auth modal in register mode. AuthForm calls router.refresh() on
 *    success, so the server page re-answers and this badge flips to `claim`
 *    (fresh account) or disappears (ineligible account).
 *
 * Docked above the 5-tab bar (TabBar is `h-16` + safe-area, `lg:hidden`), so it
 * sits on the same rail as the pack page's mobile buy dock and drops to a plain
 * inset once the tab bar is gone at lg.
 */
export default function FreePackBadge({
  state,
}: {
  state: Exclude<FreePackState, { mode: 'hidden' }>;
}) {
  const reduced = usePrefersReducedMotion();
  // While cookie consent is undecided the banner (z-50) docks on exactly this
  // rail and swallows the badge's taps — the same collision the vault action bar
  // hits (see VaultClient). Hold the badge until the visitor answers;
  // CONSENT_EVENT re-renders it the moment they do.
  const consent = useConsent();
  if (consent === null) return null;

  const shellCls =
    'fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 block transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white lg:bottom-6';
  const art = (
    <Image
      src="/images/polycards/free-pack-badge.webp"
      alt="Free welcome pack"
      width={112}
      height={146}
      // Decorative-adjacent chrome, but it IS the control's only visible
      // content, so it keeps a real alt; priority is deliberately off (it must
      // never compete with the catalog art for bandwidth).
      className={cn(
        'h-auto w-[112px] drop-shadow-[0_8px_24px_rgba(0,0,0,0.55)]',
        // Gentle idle bob — reuses globals.css's `slabFloat` (±8px) rather
        // than minting a second identical keyframe. No fill-mode (repo rule:
        // never `both`), and `infinite`, so settle-then-read QA must filter it
        // out. Doubly reduced-motion safe: the `motion-safe:` variant drops it
        // in CSS and `reduced` drops it in JS.
        !reduced && 'motion-safe:animate-[slabFloat_3s_ease-in-out_infinite]',
      )}
    />
  );

  if (state.mode === 'signup') {
    return (
      <button
        type="button"
        onClick={() => openAuth('signup')}
        data-testid="free-pack-badge"
        aria-label="Sign up to claim your free welcome pack"
        className={shellCls}
      >
        {art}
      </button>
    );
  }
  return (
    <Link
      href={`/slots/${encodeURIComponent(state.slug)}`}
      data-testid="free-pack-badge"
      aria-label="Claim your free welcome pack"
      className={shellCls}
    >
      {art}
    </Link>
  );
}

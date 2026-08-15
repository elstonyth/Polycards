'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import type { FreePackState } from '@/lib/data/free-pack';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useConsent } from '@/lib/use-consent';
import { cn } from '@/lib/utils';

/**
 * The free welcome pack's ONLY entry point — a floating badge.
 *
 * Two variants sharing one visual:
 *  - `claim`  — an eligible customer; links straight to the (uncataloged)
 *    pack's spin page, so one tap lands on the reels.
 *  - `signup` — a logged-out visitor while an active free pack exists; opens
 *    the auth modal in register mode. AuthForm calls router.refresh() on
 *    success, so the server page re-answers and this badge flips to `claim`
 *    (fresh account) or disappears (ineligible account).
 *
 * Rendered two ways: /slots passes server-read state directly (so the catalog
 * can reserve scroll clearance for it), and every other page gets it via
 * GlobalFreePackBadge below.
 *
 * Docked above the 5-tab bar (TabBar is `h-16` + safe-area, `lg:hidden`), so it
 * sits on the same rail as the pack page's mobile buy dock and drops to a plain
 * inset once the tab bar is gone at lg. `z-30`, one below the three z-40
 * bottom-rail docks it can land over (the pack page's buy dock, the vault's
 * Sell action bar, the leaderboard's sheet trigger) — GlobalFreePackBadge's
 * route skip below keeps it off those pages entirely, but the lower z-index is
 * cheap belt-and-suspenders against a future dock this file doesn't know about.
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
    'fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 block transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white lg:bottom-6';
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
      href={`/slots/${encodeURIComponent(state.slug)}/spin`}
      data-testid="free-pack-badge"
      aria-label="Claim your free welcome pack"
      className={shellCls}
    >
      {art}
    </Link>
  );
}

// Focus/nav refetches are throttled to one per this window per identity. The
// 2026-07-07 incident was a sustained store-read ceiling from exactly this
// kind of chrome fan-out (see create-unread-dot.tsx's REFETCH_TTL_MS) — this
// badge fires on EVERY client-side navigation rather than just a focus event,
// so it needs the same guard even more than that one does.
const REFETCH_TTL_MS = 30_000;

// Module-level, not component state: GlobalFreePackBadge is a layout
// singleton for the whole session (one mount), so one shared counter is
// enough, and it lets the answer survive across the pathname changes that
// retrigger the effect below.
let lastFetch: { key: string; at: number; state: FreePackState } | null = null;

/** Test seam: module state outlives a test's fixtures. */
export function clearFreePackBadgeThrottle(): void {
  lastFetch = null;
}

/** Routes that own a z-40 bottom-rail control the badge would collide with:
 *  every pack detail page's mobile buy dock ("Open Pack"/"Log in" —
 *  PackDetailClient.tsx), the vault's Sell action bar, the leaderboard's
 *  sheet trigger — plus the catalog itself, which renders FreePackBadge from
 *  its own server-read state (CatalogClient.tsx) and must never also get a
 *  second, client-fetched copy from this mount. Unconditional on
 *  `state.mode`: a guest's signup badge sits on the SAME "Log in" dock a
 *  claim badge would sit on for a member. */
function isSkippedRoute(pathname: string): boolean {
  return (
    pathname === '/slots' ||
    pathname.startsWith('/slots/') ||
    pathname === '/vault' ||
    pathname === '/leaderboard'
  );
}

/**
 * True when `pathname` IS the customer's own claimable free pack's detail (or
 * spin) page — the badge would only link back to where the visitor already
 * is. Segment-compared, not prefix-compared: `/slots/<slug>-2` must NOT match
 * `/slots/<slug>`. Raw slug, not encodeURIComponent: usePathname() answers
 * decoded, so an encoded comparison would miss any slug with special
 * characters (the href in FreePackBadge still encodes — that side goes INTO
 * a URL).
 *
 * With isSkippedRoute's blanket `/slots/`-prefixed skip in place this
 * predicate is defense-in-depth — GlobalFreePackBadge never fetches or
 * renders on ANY `/slots/<slug>*` page, own pack or not — kept because a
 * future narrowing of that skip (e.g. scoping it to just the detail page)
 * would silently resurrect this exact bug if the segment check weren't still
 * here.
 */
export function isOwnFreePackPath(pathname: string, slug: string): boolean {
  const seg = pathname.split('/');
  return seg[1] === 'slots' && seg[2] === slug;
}

/**
 * Site-wide mount (layout.tsx): re-reads /api/free-pack on route or auth
 * change (throttled — see REFETCH_TTL_MS above), so the badge follows the
 * visitor everywhere and disappears within one throttle window after the
 * claim is spent. Skips every route that owns a colliding dock
 * (isSkippedRoute) and the free pack's own detail/spin pages
 * (isOwnFreePackPath).
 */
export function GlobalFreePackBadge() {
  const pathname = usePathname();
  const { customer, isLoading } = useAuth();
  const customerId = customer?.id ?? null;
  const [state, setState] = useState<FreePackState>({ mode: 'hidden' });

  useEffect(() => {
    // Hold until the auth hydrate settles so a logged-in visitor never sees
    // the guest promo answer flash before the per-customer one. Skips every
    // route this badge must not appear on too — those pages already paid for
    // their own layout without this fetch.
    if (isLoading || isSkippedRoute(pathname)) return;
    const key = customerId ?? 'guest';
    // Identity change (login/logout) busts the throttle immediately — the key
    // mismatch below skips the reuse branch and always refetches.
    if (
      lastFetch &&
      lastFetch.key === key &&
      Date.now() - lastFetch.at < REFETCH_TTL_MS
    ) {
      // Deferred into a microtask, not called synchronously in the effect
      // body: react-hooks/set-state-in-effect traces through a direct call
      // the same way create-unread-dot.tsx's mount effect had to work around
      // (see its comment) — the setState has to sit lexically inside a
      // callback.
      const cached = lastFetch.state;
      void Promise.resolve().then(() => setState(cached));
      return;
    }
    let cancelled = false;
    // Stamped before the fetch settles, not after: a burst of route changes
    // while the request is in flight must not each restart the window.
    // ponytail: a rapid re-nav can still cancel the only in-flight read below
    // (cancelled=true, same as before this throttle existed), leaving the
    // last answer stale for up to REFETCH_TTL_MS instead of self-healing on
    // the very next render — a genRef guard (see create-unread-dot.tsx) is
    // the upgrade if that ever shows up in practice.
    const firedAt = Date.now();
    lastFetch = { key, at: firedAt, state: { mode: 'hidden' } };
    void fetch('/api/free-pack', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<FreePackState>) : null))
      .then((next) => {
        if (cancelled || !next) return;
        // Same-origin self-API, but a malformed answer must fail to hidden —
        // the badge is an enhancement, never an error surface.
        const resolved: FreePackState =
          next.mode === 'claim' && typeof next.slug === 'string'
            ? next
            : next.mode === 'signup'
              ? { mode: 'signup' }
              : { mode: 'hidden' };
        lastFetch = { key, at: firedAt, state: resolved };
        setState(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, customerId, isLoading]);

  if (state.mode === 'hidden') return null;
  if (isSkippedRoute(pathname)) return null;
  if (state.mode === 'claim' && isOwnFreePackPath(pathname, state.slug)) {
    return null;
  }
  return <FreePackBadge state={state} />;
}

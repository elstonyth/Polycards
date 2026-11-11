'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import type { FreePackState } from '@/lib/data/free-pack';
import { useConsent } from '@/lib/use-consent';

/**
 * The free welcome pack's entry point everywhere but home — a floating chip.
 * Home carries the offer inline in its hero instead (home/HeroFreePack.tsx),
 * so the global mount skips "/" (isSkippedRoute).
 *
 * Matte house chip since 2026-11-11 (home critique): the old comic-burst art
 * with a red NEW sticker, drop shadow and idle bob was the cheap-gacha look
 * PRODUCT.md rules out, and it sat over the pack ladder's prices.
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
  // While cookie consent is undecided the banner (z-50) docks on exactly this
  // rail and swallows the badge's taps — the same collision the vault action bar
  // hits (see VaultClient). Hold the badge until the visitor answers;
  // CONSENT_EVENT re-renders it the moment they do.
  const consent = useConsent();
  if (consent === null) return null;

  // One matte chip, ink glass like the tab bar it floats above: hairline,
  // no shadow, no motion. The pack mark is the free pack's own emblem.
  const shellCls =
    'glass-chrome fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-30 flex h-11 items-center gap-2 rounded-full border border-white/15 pr-4 pl-1.5 text-sm font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 lg:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]';
  const art = (
    <>
      <span className="flex size-8 items-center justify-center rounded-full bg-white/[0.06]">
        <Image
          src="/branding/polycards-mark.png"
          alt=""
          width={57}
          height={81}
          className="h-4 w-auto"
        />
      </span>
      Free pack
    </>
  );

  if (state.mode === 'signup') {
    return (
      <button
        type="button"
        onClick={() => openAuth('signup')}
        data-testid="free-pack-badge"
        aria-label="Free pack: sign up to claim your welcome pack"
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
      aria-label="Free pack: claim your welcome pack"
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

// Module-level, not component state: shared by every useFreePackState caller
// (the layout's badge singleton and home's hero row), and it lets the answer
// survive across the pathname changes that retrigger the effect.
let lastFetch: { key: string; at: number; state: FreePackState } | null = null;

/** Test seam: module state outlives a test's fixtures. */
export function clearFreePackBadgeThrottle(): void {
  lastFetch = null;
}

/** Routes the floating badge stays off. Mostly ones that own a z-40
 *  bottom-rail control the badge would collide with:
 *  every pack detail page's mobile buy dock ("Open Pack"/"Log in" —
 *  PackDetailClient.tsx), the vault's Sell action bar, the leaderboard's
 *  sheet trigger — plus the catalog itself, which renders FreePackBadge from
 *  its own server-read state (CatalogClient.tsx) and must never also get a
 *  second, client-fetched copy from this mount. Unconditional on
 *  `state.mode`: a guest's signup badge sits on the SAME "Log in" dock a
 *  claim badge would sit on for a member. */
function isSkippedRoute(pathname: string): boolean {
  return (
    // Home renders the offer inline in its hero (home/HeroFreePack.tsx), which
    // reads the same answer through useFreePackState.
    pathname === '/' ||
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
 * The visitor's free-pack answer from /api/free-pack, or `null` while there is
 * none yet for the current identity (auth still hydrating, the read in flight,
 * or `enabled` false). Re-reads on route or auth change, throttled per
 * identity (REFETCH_TTL_MS) through the module-level `lastFetch`, so the
 * floating badge and home's hero row share one read and one throttle.
 */
export function useFreePackState(enabled: boolean): FreePackState | null {
  const pathname = usePathname();
  const { customer, isLoading } = useAuth();
  const customerId = customer?.id ?? null;
  const [answer, setAnswer] = useState<{
    key: string;
    state: FreePackState;
  } | null>(null);

  useEffect(() => {
    // Hold until the auth hydrate settles so a logged-in visitor never sees
    // the guest promo answer flash before the per-customer one. A disabled
    // caller (a route the badge skips) pays for no fetch at all.
    if (isLoading || !enabled) return;
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
      void Promise.resolve().then(() => setAnswer({ key, state: cached }));
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
        setAnswer({ key, state: resolved });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, pathname, customerId, isLoading]);

  return !isLoading && answer?.key === (customerId ?? 'guest')
    ? answer.state
    : null;
}

/**
 * Site-wide mount (layout.tsx): follows the visitor everywhere and disappears
 * within one throttle window after the claim is spent. Skips every route in
 * isSkippedRoute and the free pack's own detail/spin pages
 * (isOwnFreePackPath).
 */
export function GlobalFreePackBadge() {
  const pathname = usePathname();
  const skipped = isSkippedRoute(pathname);
  const state = useFreePackState(!skipped);

  if (!state || state.mode === 'hidden' || skipped) return null;
  if (state.mode === 'claim' && isOwnFreePackPath(pathname, state.slug)) {
    return null;
  }
  return <FreePackBadge state={state} />;
}

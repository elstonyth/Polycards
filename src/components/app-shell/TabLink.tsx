'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import { useDrawDot } from './DrawDotProvider';
import { useVaultDot } from './VaultDotProvider';
import { openGames } from './games';
import { preloadGamesSheet } from './GamesSheet';
import { TABS, isTabActive, type Tab } from './tabs';

/** How long a gated tap made while auth is still loading waits for the answer
 *  before it navigates anyway (the server gate then covers it, as before). */
const AUTH_WAIT_MS = 1500;

type Variant = 'bar' | 'pill';

/** The press, focus and tap-highlight states both variants share. */
const ITEM = 'group outline-none [-webkit-tap-highlight-color:transparent]';

// The press state is `data-pressed`, set from pointer events, not `:active`:
// Chrome on a touch screen applies :active only once it is sure the touch is
// a tap, so a normal ~90ms tap showed nothing until the finger lifted
// (measured: first change 121-133ms after touchstart with :active, the
// tab-flow target is 100ms).
const ITEM_VARIANT: Record<Variant, string> = {
  // Inset: the bar's items touch each other and the bar's edges.
  bar: 'flex min-w-0 flex-1 items-center justify-center focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40',
  // The press scale of Pill (DESIGN.md "Buttons").
  pill: 'rounded-full transition-transform data-[pressed]:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none motion-reduce:data-[pressed]:scale-100',
};

/**
 * One of the seven destinations, as the phone tab bar's item (`bar`) or the
 * desktop header's pill (`pill`). The single home of what both used to repeat:
 * the dots, the visitor gate, the Games button, plus the shared tab feedback
 * (press, focus ring, pending light, re-tap to top).
 */
export function TabLink({ tab, variant }: { tab: Tab; variant: Variant }) {
  const pathname = usePathname();
  const router = useRouter();
  const { customer, isLoading } = useAuth();
  const { show: vaultDot } = useVaultDot();
  const { show: drawDot } = useDrawDot();
  const active = isTabActive(tab, pathname);
  // Leaving a game plays the game exit (PageTransition); other moves fade.
  const inGame = TABS.some((t) => t.opens && isTabActive(t, pathname));
  // The vault's "new CARDS" dot and the Draw tab's "new gate" dot: the Me
  // tab's balance-movement dot (credits) was retired 2026-08-11 along with its
  // /me History tile — the operator did not want /transactions announcing
  // itself.
  const dotLabel =
    tab.href === '/vault' && vaultDot
      ? 'new items'
      : tab.href === '/lucky-draw' && drawDot
        ? 'new gate'
        : null;

  // A gated tap made before auth has answered. Resolved when it answers:
  // signed in goes to the page, a visitor gets signup in place, the same as a
  // tap made after. Navigating at once instead sent a visitor through the
  // server redirect to Home (/?auth=login).
  const waitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isLoading || waitTimer.current === null) return;
    clearTimeout(waitTimer.current);
    waitTimer.current = null;
    if (customer) router.push(tab.href);
    else openAuth('signup');
  }, [isLoading, customer, router, tab.href]);
  useEffect(() => {
    const timer = waitTimer;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const [pressed, setPressed] = useState(false);
  const release = () => setPressed(false);
  const press = {
    'data-pressed': pressed || undefined,
    onPointerDown: () => setPressed(true),
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
  };

  const className = cn(ITEM, ITEM_VARIANT[variant]);
  const face = (
    <TabFace tab={tab} variant={variant} active={active} dotLabel={dotLabel} />
  );

  // Games opens the picker sheet (a centred dialog on desktop) rather than
  // navigating. Its chunk starts loading on the press, ahead of the click.
  if (tab.opens) {
    return (
      <button
        type="button"
        onClick={openGames}
        {...press}
        onPointerDown={() => {
          setPressed(true);
          preloadGamesSheet();
        }}
        onTouchStart={preloadGamesSheet}
        aria-haspopup="dialog"
        aria-current={active ? 'page' : undefined}
        className={className}
      >
        {face}
      </button>
    );
  }

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click (new tab, new window) is the browser's, as with Link.
    const modified =
      e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    // The tab you are on: back to the top instead of re-navigating. Only on
    // the bare page: from /?category=poly or /lucky-draw?open=1 the tap still
    // goes to the plain href, clearing the query as it always did.
    if (pathname === tab.href && window.location.search === '' && !modified) {
      e.preventDefault();
      const still = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
      return;
    }
    if (!tab.gated || customer) return;
    // Gated tabs prompt signup in place for visitors instead of navigating
    // into the server redirect.
    e.preventDefault();
    if (!isLoading) {
      openAuth('signup');
      return;
    }
    waitTimer.current ??= setTimeout(() => {
      waitTimer.current = null;
      router.push(tab.href);
    }, AUTH_WAIT_MS);
  };

  return (
    <Link
      href={tab.href}
      transitionTypes={inGame ? ['game-out'] : undefined}
      // A visitor's tap on a gated tab opens signup, never this route.
      prefetch={tab.gated && !customer ? false : undefined}
      onClick={onClick}
      {...press}
      aria-current={active ? 'page' : undefined}
      aria-label={dotLabel ? `${tab.label}, ${dotLabel}` : undefined}
      className={className}
    >
      {face}
    </Link>
  );
}

/**
 * The icon and label. A child of the Link so it can read the Link's pending
 * state: a tapped tab takes its active colour after 100ms (a fast navigation
 * never flickers it) and keeps it until the URL commits. Outside a Link (the
 * Games button) the status is always idle.
 */
function TabFace({
  tab,
  variant,
  active,
  dotLabel,
}: {
  tab: Tab;
  variant: Variant;
  active: boolean;
  dotLabel: string | null;
}) {
  const { pending } = useLinkStatus();
  const lit = active || pending;
  const Icon = tab.icon;
  const pendingDelay = pending && !active && 'delay-100';

  if (variant === 'bar') {
    return (
      <span
        className={cn(
          'flex flex-col items-center justify-center gap-1 transition-colors',
          lit
            ? 'text-neutral-50'
            : 'text-neutral-400 group-hover:text-neutral-300',
          pendingDelay,
        )}
      >
        <span className="relative inline-flex">
          {/* The active icon's step up in size eases in rather than
              snapping — 180ms, the tab-switch feedback itself. A press dips
              it to 95% in 100ms. The global reduced-motion backstop zeroes
              both; the press is motion-safe only. */}
          <Icon
            className={cn(
              'h-6 w-6 transition-transform duration-200 ease-out group-data-[pressed]:duration-100 motion-safe:group-data-[pressed]:scale-95',
              active ? 'scale-105' : 'scale-100',
            )}
            strokeWidth={active ? 2.25 : 2}
            aria-hidden
          />
          {dotLabel && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-neutral-50"
            />
          )}
        </span>
        <span className="text-[10px] font-semibold leading-none">
          {tab.label}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors',
        lit
          ? 'bg-neutral-50 text-neutral-950'
          : 'text-neutral-400 group-hover:bg-white/5 group-hover:text-white',
        pendingDelay,
      )}
    >
      <span className="relative inline-flex">
        <Icon className="h-4 w-4" aria-hidden />
        {dotLabel && (
          // The lit pill is bg-neutral-50, so Paper White would vanish on
          // it. Normally moot (being on /vault clears the dot), but
          // reachable: a pull can land while the customer sits on the page
          // and the next focus refresh relights it.
          <span
            aria-hidden
            className={cn(
              'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full',
              lit ? 'bg-neutral-950' : 'bg-neutral-50',
            )}
          />
        )}
      </span>
      {tab.label}
    </span>
  );
}

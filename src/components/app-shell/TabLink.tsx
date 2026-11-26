'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import { useDrawDot } from './DrawDotProvider';
import { useVaultDot } from './VaultDotProvider';
import { openGames } from './games';
import { preloadGamesSheet } from './GamesSheet';
import {
  TABS,
  homeFlowShown,
  homeTapTaken,
  isTabActive,
  markerIndex,
  subscribeHomeFlow,
  type Tab,
} from './tabs';

/** How long a gated tap made while auth is still loading waits for the answer
 *  before it navigates anyway (the server gate then covers it, as before). */
const AUTH_WAIT_MS = 1500;

type Variant = 'bar' | 'pill';

/** The press, focus and tap-highlight states both variants share. Positioned,
 *  so an item paints over its nav's TabMarker. */
const ITEM =
  'group relative outline-none [-webkit-tap-highlight-color:transparent]';

/** One step of the marker per tab: its own width, a column of the nav. */
const SHIFT = [
  'translate-x-0',
  'translate-x-full',
  'translate-x-[200%]',
  'translate-x-[300%]',
  'translate-x-[400%]',
  'translate-x-[500%]',
  'translate-x-[600%]',
];

/**
 * The lit-tab marker of a nav whose tabs are equal columns: one element that
 * slides to the column of the tab you are on, so a tab change glides without
 * a page transition (those are off: PageTransition.tsx). `className` gives it
 * one column's box; the children draw it. First in the nav, under the tabs.
 */
export function TabMarker({
  tabs,
  className,
  children,
}: {
  tabs: Tab[];
  className: string;
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const homeFlow = useSyncExternalStore(
    subscribeHomeFlow,
    homeFlowShown,
    () => false,
  );
  const at = markerIndex(tabs, pathname, homeFlow);
  return (
    <span
      aria-hidden
      className={cn(
        // The clear border is the marker in forced colours, which drop
        // backgrounds and shadows.
        'pointer-events-none absolute rounded-full border border-transparent transition-[translate,opacity] duration-300 ease-(--ease-out-quart) motion-reduce:transition-none',
        at < 0 ? 'opacity-0' : SHIFT[at],
        className,
      )}
    >
      {children}
    </span>
  );
}

// The press state is `data-pressed`, set from pointer events, not `:active`:
// Chrome on a touch screen applies :active only once it is sure the touch is
// a tap, so a normal ~90ms tap showed nothing until the finger lifted
// (measured: first change 121-133ms after touchstart with :active, the
// tab-flow target is 100ms).
const ITEM_VARIANT: Record<Variant, string> = {
  // Idle tabs share the dock equally; the one you are on takes its label's
  // width. The ::before stretches the tap to the dock's full height.
  bar: "flex h-11 min-w-11 flex-1 items-center justify-center rounded-full before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-glacier aria-[current=page]:flex-none",
  // The press scale of Pill (DESIGN.md "Buttons").
  pill: 'rounded-full transition-transform data-[pressed]:scale-[0.98] focus-visible:ring-2 focus-visible:ring-glacier motion-reduce:transition-none motion-reduce:data-[pressed]:scale-100',
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
  const homeFlow = useSyncExternalStore(
    subscribeHomeFlow,
    homeFlowShown,
    () => false,
  );
  const active = isTabActive(tab, pathname, homeFlow);
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
    if (tab.href === '/' && !modified && homeTapTaken()) {
      e.preventDefault();
      return;
    }
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
    // A pill around the icon: grey once lit. A press dips it to 95% in 100ms
    // (motion-safe only).
    return (
      <span
        className={cn(
          'flex h-11 items-center justify-center rounded-full px-3.5 transition-[background-color,color,box-shadow,transform] duration-200 group-data-[pressed]:duration-100 motion-safe:group-data-[pressed]:scale-95 max-[359px]:px-3',
          lit
            ? 'bg-neutral-700 text-glacier shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]'
            : 'text-neutral-400 group-hover:text-neutral-200',
          pendingDelay,
        )}
      >
        <span className="relative inline-flex">
          <Icon
            className="h-6 w-6"
            strokeWidth={active ? 2.25 : 2}
            aria-hidden
          />
          {dotLabel && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-coral"
            />
          )}
        </span>
        {/* The label opens only on the page you are on, never while pending:
            two open labels would not fit a 320px phone. Width eases through
            the grid column, 0fr to 1fr. */}
        <span
          className={cn(
            'grid transition-[grid-template-columns,opacity] duration-300 ease-(--ease-out-quart) motion-reduce:transition-none',
            active
              ? 'grid-cols-[1fr] opacity-100'
              : 'grid-cols-[0fr] opacity-0',
          )}
        >
          <span className="min-w-0 overflow-hidden">
            <span className="block pl-2 text-[13px] leading-none font-semibold whitespace-nowrap">
              {tab.label}
            </span>
          </span>
        </span>
      </span>
    );
  }

  // The desktop link: a label in its column of the header's nav pill. The
  // nav's TabMarker lights the page you are on; the link only takes the
  // glacier tone.
  return (
    <span
      className={cn(
        'flex h-9 items-center justify-center rounded-full px-4 text-sm font-semibold transition-colors',
        lit
          ? 'text-glacier'
          : 'text-neutral-400 group-hover:bg-white/5 group-hover:text-white',
        pendingDelay,
      )}
    >
      <span className="relative">
        {tab.label}
        {dotLabel && (
          <span
            aria-hidden
            className="absolute -top-1 -right-2 h-2 w-2 rounded-full bg-coral"
          />
        )}
      </span>
    </span>
  );
}

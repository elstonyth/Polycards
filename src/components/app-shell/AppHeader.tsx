'use client';

import Link from 'next/link';
import { LogIn, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import { useCountedValue } from '@/lib/use-counted-value';
import AuthModalLoader from '@/components/AuthModalLoader';
import PolycardsLogo from '@/components/brand/PolycardsLogo';
import PolycardsMark from '@/components/brand/PolycardsMark';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import NotificationBell from '@/components/NotificationBell';
import { Pill } from '@/components/ui/pill';
import { SoundMenu } from './SoundMenu';
import { useTopUp } from './TopUpProvider';
import { TabLink, TabMarker } from './TabLink';
import { TABS, homeTapTaken } from './tabs';

/**
 * App header: logo left, balance chip + top-up entry right (90scard's
 * profile-corner pattern), present on every screen. On lg+ the seven tab
 * destinations render inline here because the bottom TabBar is hidden.
 */
export default function AppHeader() {
  const { customer, isLoading } = useAuth();
  const { balance, openTopUp } = useTopUp();
  // A pack open or a sell-back moves this number; counting to the new figure
  // (and tinting money-in green for a beat) is what tells the customer the
  // action landed. Snaps under reduced motion; the tint still fires.
  const { value: countedBalance, direction } = useCountedValue(balance);

  return (
    <header
      data-site-chrome
      // Its own still layer during page transitions (globals.css).
      className="glass-chrome px-fluid sticky top-0 z-50 border-b border-white/10 py-3 [view-transition-name:site-header]"
    >
      <div className="flex items-center justify-between gap-2 min-[375px]:gap-3">
        {/* Clips rather than slides under the buttons if a phone is ever too
            narrow (a long balance on a 280px fold screen). */}
        {/* p-1/-m-1 leaves room for the logo's focus ring inside the clip. */}
        <div className="flex min-w-0 items-center gap-5 max-lg:-m-1 max-lg:overflow-hidden max-lg:p-1">
          <Link
            href="/"
            className="flex min-h-11 min-w-11 shrink-0 items-center"
            aria-label="Polycards home"
            onClick={(e) => {
              const modified =
                e.button !== 0 ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey;
              if (!modified && homeTapTaken()) e.preventDefault();
            }}
          >
            {/* Under 430px the wordmark, mute, bell and balance chip do not
                fit side by side (the mute button sat on the wordmark), so
                phones get the mark alone. */}
            {/* Vector art: the mark keeps the old picture's 57x81 box so it
                sits exactly where the PNG did. */}
            <PolycardsMark
              box="logo"
              className="h-7 w-auto shrink-0 text-white min-[430px]:hidden"
            />
            <PolycardsLogo className="hidden h-7 w-auto shrink-0 text-white min-[430px]:block lg:h-8" />
          </Link>

          {/* Desktop nav — all seven destinations, as equal columns of one
              pill so the marker can step a column at a time. */}
          <nav
            aria-label="Primary"
            className="relative hidden auto-cols-fr grid-flow-col rounded-full border border-white/10 bg-white/[0.04] p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] lg:grid"
          >
            {/* The page you are on: a raised pill with a glacier lamp on the
                nav's top edge (4px padding and a 1px border each = the 6px it
                rises by), its light falling onto the pill. The 7 is
                TABS.length. */}
            <TabMarker
              tabs={TABS}
              className="inset-y-1 left-1 w-[calc((100%-0.5rem)/7)] bg-white/[0.07] shadow-[inset_0_1px_0_rgb(255_255_255/0.1)]"
            >
              <span className="absolute -top-[6px] left-1/2 h-1 w-8 -translate-x-1/2 rounded-t-full bg-glacier">
                <span className="absolute -top-2 -left-2 h-6 w-12 rounded-full bg-glacier/20 blur-md" />
                <span className="absolute -top-1 h-6 w-8 rounded-full bg-glacier/20 blur-md" />
                <span className="absolute top-0 left-2 h-4 w-4 rounded-full bg-glacier/20 blur-sm" />
              </span>
            </TabMarker>
            {TABS.map((tab) => (
              <TabLink key={tab.href} tab={tab} variant="pill" />
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1 min-[375px]:gap-2">
          <SoundMenu />
          {customer ? (
            <>
              <NotificationBell />
              {/* Translucent tint only — no refraction: the chip sits inside
                  the header's own backdrop-filter (a backdrop root), so a
                  nested filter refracts an already-blurred tint invisibly
                  while costing a live filter on every scroll. */}
              <button
                type="button"
                onClick={openTopUp}
                aria-label={
                  balance == null
                    ? 'Top up credits'
                    : `Balance ${rm(balance)} — top up`
                }
                className="flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/10 py-1 pr-1 pl-3 transition-colors hover:bg-white/15 min-[375px]:pl-3.5"
              >
                {/* DESIGN.md "Money Is Display": the balance is the app's most
                    repeated RM value — set it in the Nekst ledger voice, not
                    Geist chrome. tabular-nums keeps digits from jittering. */}
                <span
                  className={cn(
                    'font-heading text-[14px] leading-none tabular-nums transition-colors duration-300 min-[375px]:text-[15px]',
                    // Money-in gets the green beat (DESIGN.md's one use for
                    // it); spending is not an error, so a debit just counts
                    // down in plain white.
                    direction === 'up' ? 'text-buyback-fg' : 'text-white',
                  )}
                >
                  {countedBalance == null ? 'RM —' : rm(countedBalance)}
                </span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-50 text-neutral-950">
                  <Plus className="h-4 w-4" strokeWidth={3} aria-hidden />
                </span>
              </button>
            </>
          ) : isLoading ? (
            // Auth state unknown for one beat on load — hold layout, no flash.
            <div
              aria-hidden
              className="h-10 w-28 animate-pulse rounded-full bg-neutral-800"
            />
          ) : (
            <>
              <Pill
                variant="secondary"
                size="md"
                onClick={() => openAuth('login')}
              >
                <LogIn className="h-4 w-4" aria-hidden />
                Login
              </Pill>
              {/* A visitor's one main action, on every page. */}
              <Pill
                variant="glacier"
                size="md"
                onClick={() => openAuth('signup')}
              >
                Join
              </Pill>
            </>
          )}
        </div>
      </div>

      {/* Global login/signup modal (no standalone /login page). */}
      <AuthModalLoader />
    </header>
  );
}

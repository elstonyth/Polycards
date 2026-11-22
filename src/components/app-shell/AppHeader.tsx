'use client';

import Link from 'next/link';
import { LogIn, Plus, Volume2, VolumeX } from 'lucide-react';
import { useSound } from '@/lib/use-sound';
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
import { useTopUp } from './TopUpProvider';
import { TabLink } from './TabLink';
import { TABS, homeTapTaken } from './tabs';

/**
 * App header: logo left, balance chip + top-up entry right (90scard's
 * profile-corner pattern), present on every screen. On lg+ the seven tab
 * destinations render inline here because the bottom TabBar is hidden.
 */
export default function AppHeader() {
  const { customer, isLoading } = useAuth();
  const { muted, toggleMuted } = useSound();
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
            className="flex min-h-11 shrink-0 items-center"
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

          {/* Desktop nav — same seven destinations as the mobile tab bar. */}
          <nav
            aria-label="Primary"
            className="hidden items-center gap-0.5 lg:flex"
          >
            {TABS.map((tab) => (
              <TabLink key={tab.href} tab={tab} variant="pill" />
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-1 min-[375px]:gap-2">
          <Pill
            variant="ghost"
            className="w-11 px-0"
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={muted}
            title={muted ? 'Unmute sound' : 'Mute sound'}
            onClick={toggleMuted}
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden />
            )}
          </Pill>
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
              <Pill size="md" onClick={() => openAuth('signup')}>
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

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogIn, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import { useCountedValue } from '@/lib/use-counted-value';
import AuthModal from '@/components/AuthModal';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import NotificationBell from '@/components/NotificationBell';
import { Pill } from '@/components/ui/pill';
import { useTopUp } from './TopUpProvider';
import { useVaultDot } from './VaultDotProvider';
import { TABS, isTabActive } from './tabs';

const LOGO_SRC = '/branding/polycards-logo.png';

/**
 * App header: logo left, balance chip + top-up entry right (90scard's
 * profile-corner pattern), present on every screen. On lg+ the five tab
 * destinations render inline here because the bottom TabBar is hidden.
 */
export default function AppHeader() {
  const pathname = usePathname();
  const { customer, isLoading } = useAuth();
  const { balance, openTopUp } = useTopUp();
  const { show: vaultDot } = useVaultDot();
  // A pack open or a sell-back moves this number; counting to the new figure
  // (and tinting money-in green for a beat) is what tells the customer the
  // action landed. Snaps under reduced motion; the tint still fires.
  const { value: countedBalance, direction } = useCountedValue(balance);

  return (
    <header
      data-site-chrome
      className="glass-chrome px-fluid sticky top-0 z-50 border-b border-white/10 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-5">
          <Link
            href="/"
            className="flex shrink-0 items-center"
            aria-label="Polycards home"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LOGO_SRC}
              alt="Polycards"
              width={128}
              height={44}
              className="h-7 w-auto object-contain lg:h-8"
            />
          </Link>

          {/* Desktop nav — same five destinations as the mobile tab bar. */}
          <nav
            aria-label="Primary"
            className="hidden items-center gap-0.5 lg:flex"
          >
            {TABS.map((tab) => {
              const active = isTabActive(tab, pathname);
              const Icon = tab.icon;
              const dot = vaultDot && tab.href === '/vault';
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  // Gated tabs prompt signup in place for visitors (see TabBar).
                  onClick={
                    tab.gated && !customer && !isLoading
                      ? (e) => {
                          e.preventDefault();
                          openAuth('signup');
                        }
                      : undefined
                  }
                  aria-current={active ? 'page' : undefined}
                  aria-label={dot ? `${tab.label}, new items` : undefined}
                  className={cn(
                    'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors',
                    active
                      ? 'bg-neutral-50 text-neutral-950'
                      : 'text-neutral-400 hover:bg-white/5 hover:text-white',
                  )}
                >
                  <span className="relative inline-flex">
                    <Icon className="h-4 w-4" aria-hidden />
                    {dot && (
                      // The active pill is bg-neutral-50, so Paper White would
                      // vanish on it. Normally moot (being on /vault clears the
                      // dot), but reachable: a pull can land while the customer
                      // sits on the page and the next focus refresh relights it.
                      <span
                        aria-hidden
                        className={cn(
                          'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full',
                          active ? 'bg-neutral-950' : 'bg-neutral-50',
                        )}
                      />
                    )}
                  </span>
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
                className="flex h-11 items-center gap-2 rounded-full border border-white/15 bg-white/10 py-1 pl-3.5 pr-1 transition-colors hover:bg-white/15"
              >
                {/* DESIGN.md "Money Is Display": the balance is the app's most
                    repeated RM value — set it in the Nekst ledger voice, not
                    Geist chrome. tabular-nums keeps digits from jittering. */}
                <span
                  className={cn(
                    'font-heading text-[15px] leading-none tabular-nums transition-colors duration-300',
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
      <AuthModal />
    </header>
  );
}

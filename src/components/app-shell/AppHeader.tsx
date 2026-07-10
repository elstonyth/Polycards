'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogIn, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import AuthModal from '@/components/AuthModal';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import NotificationBell from '@/components/NotificationBell';
import { Pill } from '@/components/ui/pill';
import { useTopUp } from './TopUpProvider';
import { TABS, isTabActive } from './tabs';

const LOGO_SRC = '/branding/pokenic-logo.png';

/**
 * App header: logo left, balance chip + top-up entry right (90scard's
 * profile-corner pattern), present on every screen. On lg+ the five tab
 * destinations render inline here because the bottom TabBar is hidden.
 */
export default function AppHeader() {
  const pathname = usePathname();
  const { customer, isLoading } = useAuth();
  const { balance, openTopUp } = useTopUp();

  return (
    <header
      data-site-chrome
      className="px-fluid sticky top-0 z-50 border-b border-white/10 bg-neutral-950 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-5">
          <Link
            href="/"
            className="flex shrink-0 items-center"
            aria-label="PixelSlot home"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LOGO_SRC}
              alt="PixelSlot"
              width={88}
              height={44}
              className="h-7 w-auto object-contain lg:h-9"
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
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors',
                    active
                      ? 'bg-neutral-50 text-neutral-950'
                      : 'text-neutral-400 hover:bg-white/5 hover:text-white',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
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
              <button
                type="button"
                onClick={openTopUp}
                aria-label={
                  balance == null
                    ? 'Top up credits'
                    : `Balance ${rm(balance)} — top up`
                }
                className="flex h-11 items-center gap-2 rounded-full bg-neutral-800 py-1 pl-3.5 pr-1 transition-colors hover:bg-neutral-700"
              >
                {/* DESIGN.md "Money Is Display": the balance is the app's most
                    repeated RM value — set it in the Nekst ledger voice, not
                    Geist chrome. tabular-nums keeps digits from jittering. */}
                <span className="font-heading text-[15px] leading-none tabular-nums text-white">
                  {balance == null ? 'RM —' : rm(balance)}
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

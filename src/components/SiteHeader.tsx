'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ChevronDown,
  CircleDot,
  HelpCircle,
  Layers,
  Library,
  LogIn,
  Menu,
  PartyPopper,
  Sparkles,
  Store,
  Trophy,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { features } from '@/lib/features';
import AuthModal from './AuthModal';
import { openAuth } from './AuthButton';
import { useAuth } from './auth/AuthProvider';
import UserMenu from './auth/UserMenu';
import { logout } from '@/lib/actions/auth';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
  /** Render as a non-clickable, dimmed "coming soon" tab instead of a link. */
  disabled?: boolean;
  /** Screen-reader label for a disabled tab (visible text stays short). */
  ariaLabel?: string;
};

// Built from feature flags: Marketplace tab is omitted entirely while hidden, and
// Pack Party collapses to a non-clickable "Coming Soon" tab. Flip the env vars
// (see src/lib/features.ts) to restore the real links.
const NAV_ITEMS: NavItem[] = [
  { label: 'Packs', href: '/claw', icon: Layers, badge: 'NEW' },
  features.packParty
    ? { label: 'Pack Party', href: '/pack-party', icon: PartyPopper }
    : {
        label: 'Coming Soon',
        href: '/pack-party',
        icon: PartyPopper,
        disabled: true,
        ariaLabel: 'Pack Party — coming soon',
      },
  ...(features.marketplace
    ? [{ label: 'Marketplace', href: '/marketplace', icon: Store } as NavItem]
    : []),
  { label: 'Leaderboard', href: '/leaderboard', icon: Trophy },
];

// Items in the "More" dropdown (match the live nav's More menu).
const MORE_ITEMS: NavItem[] = [
  { label: 'Activity', href: '/activity', icon: Activity },
  { label: 'Pokémon', href: '/pokemon/generation/1', icon: CircleDot },
  { label: 'Series', href: '/series', icon: Library },
];

const LOGO_SRC = '/branding/pokenic-logo.png';

function NewBadge() {
  return (
    <span className="rounded bg-gradient-to-r from-emerald-500 to-green-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm">
      NEW
    </span>
  );
}

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { customer, setCustomer } = useAuth();

  async function handleMobileLogout() {
    setMenuOpen(false);
    await logout();
    setCustomer(null);
    router.push('/');
    router.refresh();
  }

  // Close the desktop "More" dropdown on outside click or Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node))
        setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  return (
    <header
      data-site-chrome
      className="px-fluid sticky top-0 z-50 border-b border-neutral-800 bg-neutral-900 py-3 transition-all duration-300"
    >
      <div className="flex items-center justify-between gap-4">
        {/* Left cluster: hamburger (mobile, far LEFT per live) + logo + desktop nav */}
        <div className="flex min-w-0 items-center gap-2 lg:gap-5">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-neutral-200 transition-all duration-200 hover:bg-white/10 hover:text-white lg:hidden"
          >
            {menuOpen ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Menu className="h-5 w-5" aria-hidden />
            )}
          </button>
          <Link
            href="/"
            className="flex shrink-0 items-center"
            aria-label="Pokenic home"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LOGO_SRC}
              alt="Pokenic"
              width={88}
              height={44}
              className="h-7 w-auto object-contain lg:h-11"
            />
          </Link>

          <nav className="hidden items-center gap-0.5 lg:flex">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              if (item.disabled) {
                return (
                  <span
                    key={item.label}
                    aria-disabled="true"
                    aria-label={item.ariaLabel}
                    className="flex h-10 cursor-not-allowed items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-neutral-500"
                  >
                    <Icon className="h-4 w-4 text-neutral-600" aria-hidden />
                    {item.label}
                  </span>
                );
              }
              return (
                <a
                  key={item.label}
                  href={item.href}
                  className="flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
                >
                  <Icon className="h-4 w-4 text-neutral-400" aria-hidden />
                  {item.label}
                  {item.badge && <NewBadge />}
                </a>
              );
            })}
            <div className="relative" ref={moreRef}>
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                className="flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
              >
                <Sparkles className="h-4 w-4 text-neutral-400" aria-hidden />
                More
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform duration-200',
                    moreOpen && 'rotate-180',
                  )}
                  aria-hidden
                />
              </button>
              {moreOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-full z-50 mt-1 min-w-[200px] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/40"
                >
                  {MORE_ITEMS.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.label}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setMoreOpen(false)}
                        className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-neutral-200 transition-colors duration-150 hover:bg-white/5 hover:text-white"
                      >
                        <Icon
                          className="h-4 w-4 text-neutral-400"
                          aria-hidden
                        />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Right cluster: help + auth actions. On mobile live keeps ?, Login and
            Sign Up visible in the bar (wave-2 audit, measured at 390). shrink-0
            so it never clips. */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* Full "How it works" once there's room; icon-only below ~1120px so
              the cramped 1024–1100px band and mobile match live's ? button. */}
          <a
            href="/how-it-works"
            className="hidden h-10 items-center gap-2 rounded-lg bg-white/5 px-3.5 text-base font-normal text-neutral-300 transition-all duration-200 hover:bg-white/10 hover:text-white min-[1120px]:flex"
          >
            <HelpCircle className="h-4 w-4 text-neutral-400" aria-hidden />
            How it works
          </a>
          <a
            href="/how-it-works"
            aria-label="How it works"
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5 text-neutral-300 transition-all duration-200 hover:bg-white/10 hover:text-white min-[1120px]:hidden"
          >
            <HelpCircle className="h-4 w-4 text-neutral-400" aria-hidden />
          </a>
          {customer ? (
            <div className="hidden lg:block">
              <UserMenu customer={customer} />
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => openAuth('login')}
                className="flex h-10 items-center gap-2 rounded-lg bg-white/5 px-3 text-sm font-medium text-neutral-50 transition-all duration-200 ease-in-out hover:bg-white/10 sm:px-3.5"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                Login
              </button>
              <button
                type="button"
                onClick={() => openAuth('signup')}
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg bg-gradient-to-r from-white/90 via-white to-white/90 px-3.5 text-sm font-medium text-black transition-all duration-300 hover:opacity-90 sm:px-4"
              >
                Sign Up
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile menu panel */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 lg:hidden',
          menuOpen ? 'mt-3 max-h-[480px]' : 'max-h-0',
        )}
      >
        <nav className="flex flex-col gap-1 border-t border-neutral-800 pt-3">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            if (item.disabled) {
              return (
                <span
                  key={item.label}
                  aria-disabled="true"
                  aria-label={item.ariaLabel}
                  className="flex h-11 cursor-not-allowed items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-500"
                >
                  <Icon className="h-4 w-4 text-neutral-600" aria-hidden />
                  {item.label}
                </span>
              );
            }
            return (
              <a
                key={item.label}
                href={item.href}
                className="flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
              >
                <Icon className="h-4 w-4 text-neutral-400" aria-hidden />
                {item.label}
                {item.badge && <NewBadge />}
              </a>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileMoreOpen((o) => !o)}
            aria-expanded={mobileMoreOpen}
            className="flex h-11 items-center justify-between rounded-lg px-3 text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
          >
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-neutral-400" aria-hidden />
              More
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                mobileMoreOpen && 'rotate-180',
              )}
              aria-hidden
            />
          </button>
          {mobileMoreOpen && (
            <div className="ml-3 flex flex-col gap-1 border-l border-neutral-800 pl-3">
              {MORE_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.label}
                    href={item.href}
                    className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-300 transition-all duration-200 hover:bg-white/5 hover:text-white"
                  >
                    <Icon className="h-4 w-4 text-neutral-400" aria-hidden />
                    {item.label}
                  </a>
                );
              })}
            </div>
          )}
          <a
            href="/how-it-works"
            className="flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
          >
            <HelpCircle className="h-4 w-4 text-neutral-400" aria-hidden />
            How it works
          </a>

          <div className="mt-2 flex flex-col gap-1 border-t border-neutral-800 pt-3">
            {customer ? (
              <>
                <Link
                  href="/orders"
                  onClick={() => setMenuOpen(false)}
                  className="flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
                >
                  Orders
                </Link>
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
                >
                  Settings
                </Link>
                <button
                  type="button"
                  onClick={handleMobileLogout}
                  className="flex h-11 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-neutral-200 transition-all duration-200 hover:bg-white/5 hover:text-white"
                >
                  <LogIn className="h-4 w-4 rotate-180" aria-hidden />
                  Log out
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    openAuth('login');
                  }}
                  className="flex h-10 items-center justify-center gap-2 rounded-lg bg-white/5 px-4 text-sm font-medium text-neutral-50 transition-all duration-200 hover:bg-white/10"
                >
                  <LogIn className="h-4 w-4" aria-hidden />
                  Login
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    openAuth('signup');
                  }}
                  className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg bg-gradient-to-r from-white/90 via-white to-white/90 px-5 text-sm font-medium text-black transition-all duration-300 hover:opacity-90"
                >
                  Sign Up
                </button>
              </div>
            )}
          </div>
        </nav>
      </div>

      {/* Global login/signup modal (live uses a modal, not /login //signup pages) */}
      <AuthModal />
    </header>
  );
}
